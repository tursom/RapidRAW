//! A dedicated controller process becomes a Linux subreaper so these tests
//! can reap the actual orphan rather than leaving a zombie with container PID 1.
use super::*;

const ORPHAN_BUDGET: Duration = Duration::from_millis(1000);

fn fixture_command(name: &str, path: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--ignored", "--nocapture"])
        .env("CLIPBOARD_ORPHAN_RESULT", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn wait_for_ready(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        // Test-only handshake, NOT the production result-consumption path.
        // The supervisor continues to read results only after confirmed exit.
        if let Ok(bytes) = fs::read(path)
            && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
            && let Some(pid) = value["pid"].as_u64()
        {
            return u32::try_from(pid).unwrap();
        }
        assert!(Instant::now() < deadline, "worker did not arm its failsafe");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
#[ignore = "orphan worker fixture; launched by its disposable owner"]
fn clipboard_blocked_orphan() {
    let path = PathBuf::from(std::env::var_os("CLIPBOARD_ORPHAN_RESULT").unwrap());
    let _watchdog =
        WorkerWatchdog::arm(Instant::now() + ORPHAN_BUDGET + WORKER_EXIT_GRACE).unwrap();
    // Deliberately make normal libc exit hang. The production failsafe must
    // bypass atexit handlers while the native-reading thread is blocked.
    unsafe extern "C" {
        fn atexit(callback: extern "C" fn()) -> std::ffi::c_int;
    }
    extern "C" fn blocked_exit_handler() {
        loop {
            thread::sleep(Duration::from_secs(30));
        }
    }
    // SAFETY: static callback has the C ABI and remains valid until exit.
    assert_eq!(unsafe { atexit(blocked_exit_handler) }, 0);
    let mut ready = create_result(&path).unwrap();
    serde_json::to_writer(&mut ready, &json!({"pid": std::process::id()})).unwrap();
    ready.flush().unwrap();
    loop {
        thread::sleep(Duration::from_secs(30));
    }
}

#[test]
#[ignore = "disposable owner fixture; killed or exits without joining its worker"]
fn clipboard_orphan_owner() {
    let path = PathBuf::from(std::env::var_os("CLIPBOARD_ORPHAN_RESULT").unwrap());
    let child = fixture_command(
        "clipboard_read::tests::orphan::clipboard_blocked_orphan",
        &path,
    )
    .spawn()
    .unwrap();
    // std Child drop neither kills nor waits, matching loss of GUI ownership.
    drop(child);
    wait_for_ready(&path);
    if std::env::var("CLIPBOARD_ORPHAN_OWNER").unwrap() == "exit" {
        immediate_worker_exit(0);
    }
    loop {
        thread::sleep(Duration::from_secs(30));
    }
}

#[test]
#[ignore = "isolated subreaper controller; launched by the ordinary test"]
fn clipboard_orphan_controller() {
    unsafe extern "C" {
        fn prctl(option: std::ffi::c_int, ...) -> std::ffi::c_int;
        fn waitpid(
            pid: std::ffi::c_int,
            status: *mut std::ffi::c_int,
            options: std::ffi::c_int,
        ) -> std::ffi::c_int;
        fn kill(pid: std::ffi::c_int, signal: std::ffi::c_int) -> std::ffi::c_int;
    }
    // SAFETY: PR_SET_CHILD_SUBREAPER changes only this disposable controller;
    // no global setting is changed in the main parallel test process.
    assert_eq!(
        unsafe {
            prctl(
                36,
                1 as std::ffi::c_ulong,
                0 as std::ffi::c_ulong,
                0 as std::ffi::c_ulong,
                0 as std::ffi::c_ulong,
            )
        },
        0
    );
    let mode = std::env::var("CLIPBOARD_ORPHAN_OWNER").unwrap();
    let directory = ResultDirectory::new().unwrap();
    let mut command = fixture_command(
        "clipboard_read::tests::orphan::clipboard_orphan_owner",
        &directory.result,
    );
    command.env("CLIPBOARD_ORPHAN_OWNER", &mode);
    let mut owner = command.spawn().unwrap();
    let pid = wait_for_ready(&directory.result) as std::ffi::c_int;
    let orphaned = Instant::now();
    if mode == "kill" {
        owner.kill().unwrap();
    }
    owner.wait().unwrap();
    let deadline = orphaned + ORPHAN_BUDGET + WORKER_EXIT_GRACE + Duration::from_secs(1);
    let mut status = 0;
    loop {
        // SAFETY: pid came from our known fixture in the private directory;
        // its owner has exited and this controller adopted the child.
        let waited = unsafe { waitpid(pid, &mut status, 1) }; // WNOHANG
        if waited == pid {
            break;
        }
        assert_eq!(waited, 0, "could not wait for the adopted worker");
        if Instant::now() >= deadline {
            // Bound a regression failure as well; never leave a live fixture.
            unsafe {
                kill(pid, 9);
                waitpid(pid, &mut status, 0);
            }
            panic!("orphan worker outlived the independent failsafe");
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(status & 0x7f, 0, "worker did not exit normally via _exit");
    assert_eq!((status >> 8) & 0xff, WORKER_FAILSAFE_EXIT);
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    // Abrupt parent death intentionally retains only its own private result;
    // this test has proven the child exited and can now clean the known path.
    assert!(fs::metadata(&directory.result).unwrap().len() <= MAX_RESULT_BYTES);
    directory.cleanup().unwrap();
}

#[test]
fn clipboard_worker_self_failsafe_bounds_killed_and_exited_parent() {
    for mode in ["kill", "exit"] {
        let directory = ResultDirectory::new().unwrap();
        let mut command = fixture_command(
            "clipboard_read::tests::orphan::clipboard_orphan_controller",
            &directory.result,
        );
        command.env("CLIPBOARD_ORPHAN_OWNER", mode);
        let mut controller = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(status) = controller.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "{mode} orphan controller failed: {status}"
                );
                break;
            }
            if Instant::now() >= deadline {
                controller.kill().unwrap();
                controller.wait().unwrap();
                panic!("orphan controller exceeded test deadline");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

#[test]
fn clipboard_worker_watchdog_disarms_and_joins_after_success() {
    let armed = Instant::now();
    drop(WorkerWatchdog::arm(armed + Duration::from_secs(30)).unwrap());
    assert!(armed.elapsed() < Duration::from_secs(1));
}
