//! Bounded clipboard reads. Only the disposable worker calls native APIs.
//! The supervisor never waits on a pipe or abandons a clipboard-reading thread.
use crate::{ImageReadMode, build_metadata, read_snapshot};
use clipboard_rs::ClipboardContext;
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU8, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Provisional timing policy, not a measured macOS completion guarantee.
pub const PROVISIONAL_FOCUS_GUARD: Duration = Duration::from_millis(500);
pub const PROVISIONAL_READ_BUDGET: Duration = Duration::from_secs(3);
pub const PROVISIONAL_RETRY_INTERVAL: Duration = Duration::from_millis(200);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const WORKER_FLAG: &str = "--intake-clipboard-worker-v1";
const MAX_RESULT_BYTES: u64 = 1024 * 1024;
// Orphan-process failsafe only. This is NOT extra user read budget: the parent
// still enforces its original deadline and rejects every late result.
const WORKER_EXIT_GRACE: Duration = Duration::from_millis(250);
const WORKER_FAILSAFE_EXIT: i32 = 124;
const IDLE: u8 = 0;
const READING: u8 = 1;
const POISONED: u8 = 2;

/// Exit without Rust destructors, libc atexit handlers, or framework teardown.
/// Those may need locks held by the blocked native-reading thread.
fn immediate_worker_exit(code: i32) -> ! {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn _exit(status: std::ffi::c_int) -> !;
        }
        // SAFETY: _exit terminates the current process and takes no pointers.
        unsafe { _exit(code) }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn TerminateProcess(process: *mut std::ffi::c_void, exit_code: u32) -> i32;
        }
        // SAFETY: GetCurrentProcess supplies the documented pseudo-handle for
        // this process. No process supplied by a caller can be terminated.
        unsafe {
            TerminateProcess(GetCurrentProcess(), code as u32);
        }
        std::process::abort()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = code;
        std::process::abort()
    }
}

// Exists only inside the disposable worker, never in the parent supervisor.
// On normal completion it is disarmed and joined. On timeout it terminates
// every thread in this process, including the one blocked in AppKit.
struct WorkerWatchdog {
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WorkerWatchdog {
    fn arm(deadline: Instant) -> io::Result<Self> {
        let (stop, receive) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("clipboard-worker-failsafe".to_owned())
            .spawn(move || {
                if receive
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .is_err()
                {
                    immediate_worker_exit(WORKER_FAILSAFE_EXIT);
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for WorkerWatchdog {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Share one gate across all commands for an application instance.
/// The permit lasts through focus protection, process exit and result cleanup.
#[derive(Default)]
pub struct ClipboardReadGate {
    state: AtomicU8,
}

struct Permit<'a>(&'a ClipboardReadGate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        // Never clear a cleanup failure, including during unwinding.
        let _ = self
            .0
            .state
            .compare_exchange(READING, IDLE, Ordering::AcqRel, Ordering::Acquire);
    }
}

impl ClipboardReadGate {
    fn acquire(&self) -> Result<Permit<'_>, Value> {
        match self
            .state
            .compare_exchange(IDLE, READING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => Ok(Permit(self)),
            Err(POISONED) => Err(terminal("failed", "cleanup-failed-gate-poisoned")),
            Err(_) => Err(terminal("busy", "read-already-active")),
        }
    }

    fn poison(&self) {
        self.state.store(POISONED, Ordering::Release);
    }
}

fn terminal(kind: &str, reason: &str) -> Value {
    json!({
        "schema": 2, "build": build_metadata(), "kind": kind, "outcome": kind,
        "reason": reason, "selected": null, "atomicSnapshot": false,
        "timingPolicy": "provisional", "budgetMs": PROVISIONAL_READ_BUDGET.as_millis(),
    })
}

pub(crate) fn native_sequence() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as i64)
    }
    #[cfg(target_os = "windows")]
    {
        clipboard_win::seq_num().map(|value| i64::from(value.get()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

// Policy is independent of OS APIs and accepts whole-attempt results. A stable
// count cannot turn nil, a text marker, or an empty format list into completion.
pub(super) fn retry_reads(
    budget: Duration,
    interval: Duration,
    mut attempt: impl FnMut() -> Value,
) -> Value {
    let started = Instant::now();
    let deadline = started + budget;
    let mut attempts = 0u64;
    let mut last = Value::Null;
    loop {
        if Instant::now() >= deadline {
            let failed = last["invalidImageData"] == true && last["outcome"] != "invalidated";
            let kind = if failed { "failed" } else { "unresolved" };
            let mut result = terminal(kind, "read-budget-exhausted");
            result["attempts"] = json!(attempts);
            result["lastAttempt"] = last;
            result["workerTotalMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
            return result;
        }
        last = attempt();
        attempts += 1;
        // Discard even a valid result if its native call/decode overran budget.
        if Instant::now() >= deadline {
            last["selected"] = Value::Null;
            last["kind"] = json!("unresolved");
            last["outcome"] = json!("late-discarded");
        } else if last["outcome"] == "success"
            || (last["kind"] == "failed" && last["outcome"] == "failed")
        {
            last["attempts"] = json!(attempts);
            last["workerTotalMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
            return last;
        }
        thread::sleep(interval.min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn worker_read(mode: ImageReadMode, budget: Duration) -> Value {
    retry_reads(budget, PROVISIONAL_RETRY_INTERVAL, || {
        let started = Instant::now();
        match ClipboardContext::new() {
            Ok(context) => {
                let context_ms = started.elapsed().as_secs_f64() * 1000.0;
                let mut result = read_snapshot(&context, mode, false);
                result["contextMs"] = json!(context_ms);
                result["totalMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
                // If a sequencing platform cannot provide a count, do not
                // silently downgrade its read to an unsequenced success.
                if cfg!(any(target_os = "macos", target_os = "windows"))
                    && result["sequenceChecked"] != true
                {
                    result["kind"] = json!("unresolved");
                    result["outcome"] = json!("retry");
                    result["selected"] = Value::Null;
                }
                result
            }
            Err(error) => {
                let mut result = terminal("unresolved", "clipboard-context-unavailable");
                result["contextError"] = json!(error.to_string());
                result
            }
        }
    })
}

fn create_result(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn private_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing result directory"))?;
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("result directory is not a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::other("result directory is not private"));
        }
    }
    Ok(())
}

/// Call before constructing Tauri (and at the start of the clipboard example).
/// `Some(code)` means this is a worker invocation: immediately exit with code.
/// This branch never creates a window, launches a supervisor, or writes stdout.
pub fn worker_entry() -> Option<i32> {
    let entered = Instant::now();
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_FLAG)) {
        return None;
    }
    let result = (|| -> Result<(), String> {
        let path = PathBuf::from(args.next().ok_or("missing result path")?);
        let mode = args.next().ok_or("missing image mode")?;
        let mode = ImageReadMode::try_from(mode.to_str().ok_or("invalid image mode")?)?;
        let budget = args.next().ok_or("missing budget")?;
        let budget: u64 = budget
            .to_str()
            .ok_or("invalid budget")?
            .parse()
            .map_err(|_| "invalid budget")?;
        if args.next().is_some()
            || budget == 0
            || budget > PROVISIONAL_READ_BUDGET.as_millis() as u64
        {
            return Err("invalid worker arguments".to_owned());
        }
        // Arm before filesystem/native access. If the GUI parent disappears,
        // a blocked call cannot keep this worker alive indefinitely. Failure
        // to start the watchdog returns before any clipboard access.
        let _watchdog =
            WorkerWatchdog::arm(entered + Duration::from_millis(budget) + WORKER_EXIT_GRACE)
                .map_err(|e| e.to_string())?;
        // A parent killed before normal cleanup can leave this private tiny
        // directory/result behind (empty, partial, or at most MAX_RESULT_BYTES).
        // The failsafe does not perform potentially blocking filesystem work
        // before _exit/TerminateProcess. No clipboard image payload is saved.
        private_parent(&path).map_err(|e| e.to_string())?;
        // Reserve before any native call; interrupted writes are never read
        // until the supervisor has confirmed this process exited.
        let mut file = create_result(&path).map_err(|e| e.to_string())?;
        let result = worker_read(mode, Duration::from_millis(budget));
        let bytes = serde_json::to_vec(&result).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_RESULT_BYTES {
            return Err("worker result exceeds limit".to_owned());
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();
    Some(if result.is_ok() { 0 } else { 2 })
}

struct ResultDirectory {
    directory: PathBuf,
    result: PathBuf,
}

impl ResultDirectory {
    fn new() -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        for _ in 0..32 {
            let directory = std::env::temp_dir().join(format!(
                "rapidraw-clipboard-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        result: directory.join("result.json"),
                        directory,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::other(
            "could not allocate private result directory",
        ))
    }

    fn cleanup(&self) -> io::Result<()> {
        match fs::remove_file(&self.result) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        match fs::remove_dir(&self.directory) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

impl Drop for ResultDirectory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

struct OwnedChild<'a> {
    child: Child,
    gate: &'a ClipboardReadGate,
    reaped: bool,
}

impl OwnedChild<'_> {
    fn poll(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    fn terminate(&mut self) -> io::Result<()> {
        if self.reaped || self.poll()?.is_some() {
            return Ok(());
        }
        if let Err(error) = self.child.kill() {
            // Exit can race with kill. Only confirmed exit makes that harmless.
            if self.poll()?.is_none() {
                self.gate.poison();
                return Err(error);
            }
            return Ok(());
        }
        match self.child.wait() {
            Ok(_) => {
                self.reaped = true;
                Ok(())
            }
            Err(error) => {
                self.gate.poison();
                Err(error)
            }
        }
    }
}

impl Drop for OwnedChild<'_> {
    fn drop(&mut self) {
        if !self.reaped && self.terminate().is_err() {
            self.gate.poison();
        }
    }
}

fn read_result(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RESULT_BYTES
    {
        return Err("worker result is not a bounded regular file".to_owned());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_RESULT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESULT_BYTES {
        return Err("worker result exceeds limit".to_owned());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let valid = value["schema"] == 2
        && match value["kind"].as_str() {
            Some("files") => {
                value["outcome"] == "success"
                    && value["selected"]["method"] == "files"
                    && value["selected"]["paths"].as_array().is_some_and(|paths| {
                        !paths.is_empty()
                            && paths
                                .iter()
                                .all(|path| path.as_str().is_some_and(|p| !p.is_empty()))
                    })
            }
            Some("image") => {
                value["outcome"] == "success"
                    && matches!(
                        value["selected"]["method"].as_str(),
                        Some("raw-png" | "decoded-reencoded")
                    )
                    && value["selected"]["bytes"].as_u64().is_some_and(|n| n > 0)
                    && value["selected"]["sha256"]
                        .as_str()
                        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            }
            Some("busy" | "failed" | "unresolved") => {
                value["selected"].is_null() && value["outcome"] == value["kind"]
            }
            _ => false,
        };
    if !valid {
        return Err("invalid worker result schema/outcome".to_owned());
    }
    Ok(value)
}

fn supervise(
    mode: ImageReadMode,
    focus_guard: Duration,
    budget: Duration,
    gate: &ClipboardReadGate,
    command: impl FnOnce(&Path, Duration) -> io::Result<Command>,
) -> Value {
    let _permit = match gate.acquire() {
        Ok(permit) => permit,
        Err(result) => return result,
    };
    let request_started = Instant::now();
    thread::sleep(focus_guard);
    let started = Instant::now();
    let deadline = started + budget;
    let directory = match ResultDirectory::new() {
        Ok(directory) => directory,
        Err(error) => {
            let mut result = terminal("failed", "result-directory-unavailable");
            result["error"] = json!(error.to_string());
            return result;
        }
    };
    let mut result = (|| {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return terminal("busy", "parent-deadline");
        }
        let mut command = match command(&directory.result, remaining) {
            Ok(command) => command,
            Err(error) => {
                let mut result = terminal("failed", "worker-start-failed");
                result["error"] = json!(error.to_string());
                return result;
            }
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if Instant::now() >= deadline {
            return terminal("busy", "parent-deadline");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let mut result = terminal("failed", "worker-start-failed");
                result["error"] = json!(error.to_string());
                return result;
            }
        };
        let pid = child.id();
        let mut child = OwnedChild {
            child,
            gate,
            reaped: false,
        };
        let mut result = loop {
            if Instant::now() >= deadline {
                break terminal("busy", "parent-deadline");
            }
            match child.poll() {
                Ok(Some(status)) => {
                    if Instant::now() >= deadline {
                        break terminal("busy", "parent-deadline");
                    }
                    if !status.success() {
                        let mut result = terminal("failed", "worker-exit-failed");
                        result["exitCode"] = json!(status.code());
                        break result;
                    }
                    // No result-file reads occur while the worker is alive.
                    let parsed = read_result(&directory.result);
                    if Instant::now() >= deadline {
                        break terminal("busy", "parent-deadline");
                    }
                    break parsed.unwrap_or_else(|error| {
                        let mut result = terminal("failed", "worker-result-invalid");
                        result["error"] = json!(error);
                        result
                    });
                }
                Ok(None) => thread::sleep(
                    POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                ),
                Err(error) => {
                    let mut result = terminal("failed", "worker-wait-failed");
                    result["error"] = json!(error.to_string());
                    break result;
                }
            }
        };
        if let Err(error) = child.terminate() {
            gate.poison();
            result = terminal("failed", "worker-cleanup-failed");
            result["error"] = json!(error.to_string());
        }
        result["workerPid"] = json!(pid);
        result["workerReaped"] = json!(child.reaped);
        result
    })();
    if let Err(error) = directory.cleanup() {
        gate.poison();
        result["kind"] = json!("failed");
        result["outcome"] = json!("failed");
        result["selected"] = Value::Null;
        result["reason"] = json!("result-cleanup-failed");
        result["cleanupError"] = json!(error.to_string());
    }
    result["imageMode"] = json!(mode.as_str());
    result["guarded"] = json!(true);
    result["focusGuardMs"] = json!(focus_guard.as_secs_f64() * 1000.0);
    result["budgetMs"] = json!(budget.as_secs_f64() * 1000.0);
    result["timingPolicy"] = json!("provisional");
    result["supervisorMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    result["totalMs"] = json!(request_started.elapsed().as_secs_f64() * 1000.0);
    result
}

/// Blocking supervisor: GUI callers must execute this off the UI thread.
/// The supplied guard is the *remaining* time since the last focus event.
/// Only the child performs clipboard access, decode, or hashing. The caller
/// must not abort/abandon this supervisor while it owns the gate and child.
pub fn read_guarded(
    mode: ImageReadMode,
    remaining_focus_guard: Duration,
    gate: &ClipboardReadGate,
) -> Value {
    supervise(
        mode,
        remaining_focus_guard.min(PROVISIONAL_FOCUS_GUARD),
        PROVISIONAL_READ_BUDGET,
        gate,
        |result, remaining| {
            let mut command = Command::new(std::env::current_exe()?);
            command
                .arg(WORKER_FLAG)
                .arg(result)
                .arg(mode.as_str())
                .arg(remaining.as_millis().max(1).to_string());
            Ok(command)
        },
    )
}

#[cfg(test)]
#[path = "../tests/clipboard_process/mod.rs"]
mod tests;
