//! Windows-only experiment; no files/text/format enumeration before the PNG read.
//! One JSON command per stdin line; emits ready before the real browser copy.
#[cfg(windows)]
mod probe {
    use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
    use clipboard_win::Clipboard as NativeClipboard;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::{
        io::{self, BufRead, Write},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetOpenClipboardWindow() -> *mut core::ffi::c_void;
        fn GetClipboardOwner() -> *mut core::ffi::c_void;
        fn GetWindowThreadProcessId(hwnd: *mut core::ffi::c_void, process: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryPerformanceCounter(counter: *mut i64) -> i32;
        fn QueryPerformanceFrequency(frequency: *mut i64) -> i32;
        fn SetLastError(error: u32);
        fn GetLastError() -> u32;
    }

    fn qpc() -> i64 {
        let mut value = 0;
        // SAFETY: Win32 writes one i64 to a valid stack allocation.
        assert_ne!(unsafe { QueryPerformanceCounter(&mut value) }, 0);
        value
    }

    fn sequence() -> Option<u32> {
        clipboard_win::seq_num().map(|value| value.get())
    }

    fn window_info(hwnd: *mut core::ffi::c_void) -> (usize, u32) {
        let mut pid = 0;
        if !hwnd.is_null() {
            // SAFETY: Win32 accepts the observed HWND and a valid output pointer.
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        }
        (hwnd as usize, pid)
    }

    fn state() -> (Option<u32>, usize, u32, usize, u32) {
        // These queries do not open, enumerate, read, or modify the clipboard.
        let (opener, opener_pid) = window_info(unsafe { GetOpenClipboardWindow() });
        let (owner, owner_pid) = window_info(unsafe { GetClipboardOwner() });
        (sequence(), opener, opener_pid, owner, owner_pid)
    }

    fn emit(value: &Value) -> io::Result<()> {
        let mut out = io::stdout().lock();
        serde_json::to_writer(&mut out, value)?;
        writeln!(out)?;
        out.flush()
    }

    fn open_once(origin: Instant) -> Value {
        let before = sequence();
        let at_ms = origin.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        // Reset only to make this explicit OpenClipboard failure attributable.
        unsafe { SetLastError(0) };
        let result = NativeClipboard::new();
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(guard) => {
                drop(guard);
                json!({"atMs": at_ms, "elapsedMs": elapsed_ms, "ok": true,
                    "sequenceBefore": before, "sequenceAfter": sequence()})
            }
            Err(error) => json!({"atMs": at_ms, "elapsedMs": elapsed_ms, "ok": false,
                "win32Code": error.raw_code(), "error": error.to_string(),
                "sequenceBefore": before, "sequenceAfter": sequence()}),
        }
    }

    fn validate(bytes: &[u8]) -> Value {
        let start = Instant::now();
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return json!({"ok": false, "error": "not a PNG signature", "bytes": bytes.len()});
        }
        match RustImageData::from_bytes(bytes) {
            Ok(image) => {
                let (width, height) = image.get_size();
                match image.to_rgba8() {
                    Ok(rgba) => json!({"ok": true, "width": width, "height": height,
                        "bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes)),
                        "rgba8Sha256": format!("{:x}", Sha256::digest(rgba.as_raw())),
                        "elapsedMs": start.elapsed().as_secs_f64() * 1000.0}),
                    Err(error) => json!({"ok": false, "error": error.to_string()}),
                }
            }
            Err(error) => json!({"ok": false, "error": error.to_string(), "bytes": bytes.len()}),
        }
    }

    fn sample(context: &ClipboardContext, command: &Value) -> io::Result<()> {
        let mode = command["mode"].as_str().unwrap_or("direct");
        let delay_ms = command["delayMs"].as_u64().unwrap_or(0);
        if !["direct", "open-retry", "observe"].contains(&mode) || delay_ms > 3000 {
            return emit(&json!({"event": "error", "error": "invalid mode/delay"}));
        }
        let origin = Instant::now();
        let origin_qpc = qpc();
        let before = sequence();
        let stopped = Arc::new(AtomicBool::new(false));
        let observer_stop = Arc::clone(&stopped);
        let observer = thread::spawn(move || {
            let mut events = Vec::new();
            let mut last = None;
            while !observer_stop.load(Ordering::Relaxed) {
                let current = state();
                if last != Some(current) {
                    events.push(json!({"atMs": origin.elapsed().as_secs_f64() * 1000.0,
                        "qpc": qpc(), "sequence": current.0,
                        "openWindow": current.1, "openPid": current.2,
                        "ownerWindow": current.3, "ownerPid": current.4}));
                    last = Some(current);
                }
                thread::sleep(Duration::from_millis(1));
            }
            events
        });
        emit(&json!({"event": "ready", "id": command["id"],
            "sequenceBefore": before, "originQpc": origin_qpc}))?;
        let wait_start = Instant::now();
        let immediate = command["trigger"] == "immediate";
        while !immediate && sequence() == before && wait_start.elapsed() < Duration::from_secs(10) {
            thread::sleep(Duration::from_millis(1));
        }
        if !immediate && sequence() == before {
            stopped.store(true, Ordering::Relaxed);
            let events = observer.join().expect("observer thread");
            return emit(&json!({"event": "result", "id": command["id"],
                "error": "No clipboard sequence change within 10 seconds", "events": events}));
        }
        let first_change = Instant::now();
        let first_change_ms = origin.elapsed().as_secs_f64() * 1000.0;
        let first_change_qpc = qpc();
        thread::sleep(Duration::from_millis(delay_ms));
        let read_at_ms = origin.elapsed().as_secs_f64() * 1000.0;
        let read_sequence = sequence();
        let read_qpc = qpc();
        let mut open_attempts = Vec::new();
        let mut payload = None;
        let mut primary = Value::Null;
        match mode {
            "direct" => {
                unsafe { SetLastError(0) };
                let start = Instant::now();
                // FIRST clipboard access. No explicit open/formats/files/text probe before this.
                let result = context.get_buffer("PNG");
                let read_ms = start.elapsed().as_secs_f64() * 1000.0;
                let last_error = unsafe { GetLastError() };
                primary = match result {
                    Ok(bytes) => {
                        let len = bytes.len();
                        payload = Some(bytes);
                        json!({"ok": true, "bytes": len})
                    }
                    Err(error) => json!({"ok": false, "error": error.to_string()}),
                };
                primary["elapsedMs"] = json!(read_ms);
                // The library erases the typed code and may format the error before returning.
                primary["threadLastErrorAfterReturnDiagnosticOnly"] = json!(last_error);
                primary["endMs"] = json!(origin.elapsed().as_secs_f64() * 1000.0);
                primary["sequenceAfter"] = json!(sequence());
                open_attempts.push(open_once(origin)); // AFTER the timed get_buffer, never before.
            }
            "open-retry" => {
                let deadline = first_change + Duration::from_secs(3);
                loop {
                    let attempt = open_once(origin);
                    let opened = attempt["ok"] == true;
                    open_attempts.push(attempt);
                    if opened || Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                primary = json!({"operation": "explicit-open-only", "opensClipboard": true,
                    "ok": open_attempts.last().is_some_and(|v| v["ok"] == true)});
            }
            "observe" => {} // Passive control: sequence/opener/owner queries only.
            _ => unreachable!(),
        }
        // Observe beyond 3 seconds, including library retries/delayed rendering.
        let deadline = first_change + Duration::from_millis(3400);
        if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            thread::sleep(remaining);
        }
        let final_open = (mode != "observe").then(|| open_once(origin));
        let end_sequence = sequence();
        let end_ms = origin.elapsed().as_secs_f64() * 1000.0;
        stopped.store(true, Ordering::Relaxed);
        let events = observer.join().expect("observer thread");
        // Full image validation is deliberately after the observation window.
        let png = payload.as_deref().map(validate);
        emit(
            &json!({"event": "result", "id": command["id"], "mode": mode,
            "anchor": if immediate { "ready" } else { "first-observed-sequence-change" },
            "requestedDelayMs": delay_ms, "originQpc": origin_qpc,
            "sequenceBefore": before, "firstChangeMs": first_change_ms,
            "firstChangeQpc": first_change_qpc, "readAtMs": read_at_ms, "readQpc": read_qpc,
            "readSequence": read_sequence, "primary": primary, "png": png,
            "openAttempts": open_attempts, "finalOpen": final_open,
            "endSequence": end_sequence, "endMs": end_ms, "events": events,
            "note": "Timer anchor is first observed sequence change, not menu release; QPC links both. Opener HWND can be zero even when clipboard is locked. Direct mode does not open/enumerate/read any other format before get_buffer. PNG validation happens after monitoring."}),
        )
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let context_start = Instant::now();
        let context = ClipboardContext::new()?;
        let context_ms = context_start.elapsed().as_secs_f64() * 1000.0;
        let mut frequency = 0;
        unsafe { QueryPerformanceFrequency(&mut frequency) };
        emit(
            &json!({"event": "started", "build": rapidraw_intake_spike::build_metadata(),
            "pid": std::process::id(), "qpcFrequency": frequency,
            "clipboardWin": "5.4.3", "contextCreatedBeforeCopy": true, "contextMs": context_ms}),
        )?;
        for line in io::stdin().lock().lines() {
            let command: Value = serde_json::from_str(&line?)?;
            sample(&context, &command)?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    probe::run()
}

#[cfg(not(windows))]
fn main() {
    eprintln!("clipboard_contention requires an interactive Windows desktop");
    std::process::exit(1);
}
