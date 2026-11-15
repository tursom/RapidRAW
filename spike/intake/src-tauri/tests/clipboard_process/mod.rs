use super::*;
use std::sync::{Arc, Barrier, Mutex};

#[cfg(target_os = "linux")]
#[path = "../clipboard_orphan/mod.rs"]
mod orphan;

fn success() -> Value {
    json!({"schema": 2, "kind": "files", "outcome": "success",
        "selected": {"method": "files", "paths": ["/tmp/fake fixture.NEF"]}})
}

// A real child test process, invoked only with --exact/--ignored below. It
// cannot call the real clipboard backend. Production has no fake-worker mode.
#[test]
#[ignore = "subprocess fixture; invoked explicitly by the supervisor tests"]
fn clipboard_fake_worker() {
    let path = PathBuf::from(std::env::var_os("CLIPBOARD_TEST_RESULT").unwrap());
    let scenario = std::env::var("CLIPBOARD_TEST_SCENARIO").unwrap();
    private_parent(&path).unwrap();
    let mut file = create_result(&path).unwrap();
    match scenario.as_str() {
        "stall-first" => thread::sleep(Duration::from_secs(30)),
        "stall-late" => {
            // First native-like attempt returns nil, the next call blocks.
            thread::sleep(Duration::from_millis(30));
            thread::sleep(Duration::from_secs(30));
        }
        "result-then-hang" => {
            serde_json::to_writer(&mut file, &success()).unwrap();
            file.flush().unwrap();
            thread::sleep(Duration::from_secs(30));
        }
        "late-valid" => {
            thread::sleep(Duration::from_millis(300));
            serde_json::to_writer(&mut file, &success()).unwrap();
        }
        "bad-json" => file.write_all(b"{broken").unwrap(),
        "huge" => file.set_len(MAX_RESULT_BYTES + 1).unwrap(),
        "old-marker" => serde_json::to_writer(
            &mut file,
            &json!({
                "schema": 2, "kind": "marker", "outcome": "success", "selected": null,
            }),
        )
        .unwrap(),
        "nonzero" => std::process::exit(7),
        "success" => serde_json::to_writer(&mut file, &success()).unwrap(),
        _ => panic!("unknown fake scenario"),
    }
    file.flush().unwrap();
}

fn fake_command(path: &Path, scenario: &str) -> io::Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "clipboard_read::tests::clipboard_fake_worker",
            "--ignored",
            "--nocapture",
        ])
        .env("CLIPBOARD_TEST_RESULT", path)
        .env("CLIPBOARD_TEST_SCENARIO", scenario);
    Ok(command)
}

fn run_fake(gate: &ClipboardReadGate, scenario: &str, budget: Duration) -> Value {
    let directory = Mutex::new(None);
    let result = supervise(
        ImageReadMode::PreferPng,
        Duration::ZERO,
        budget,
        gate,
        |path, _| {
            *directory.lock().unwrap() = Some(path.parent().unwrap().to_path_buf());
            fake_command(path, scenario)
        },
    );
    if let Some(path) = directory.into_inner().unwrap() {
        assert!(!path.exists(), "private result directory leaked: {path:?}");
    }
    if let Some(pid) = result["workerPid"].as_u64() {
        assert_eq!(result["workerReaped"], true);
        #[cfg(target_os = "linux")]
        assert!(
            !PathBuf::from(format!("/proc/{pid}")).exists(),
            "worker remains alive/zombie"
        );
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }
    result
}

#[test]
fn clipboard_process_stalls_and_late_results_are_killed_reaped_and_recover() {
    let gate = ClipboardReadGate::default();
    for scenario in [
        "stall-first",
        "stall-late",
        "result-then-hang",
        "late-valid",
    ] {
        let started = Instant::now();
        let result = run_fake(&gate, scenario, Duration::from_millis(100));
        assert_eq!(result["kind"], "busy", "{scenario}: {result}");
        assert_eq!(result["reason"], "parent-deadline");
        assert!(result["selected"].is_null());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "parent did not interrupt blocked child"
        );
        assert_eq!(
            run_fake(&gate, "success", Duration::from_secs(2))["kind"],
            "files"
        );
    }
}

#[test]
fn clipboard_process_bad_huge_marker_and_nonzero_results_fail_without_stuck_gate() {
    let gate = ClipboardReadGate::default();
    for scenario in ["bad-json", "huge", "old-marker", "nonzero"] {
        let result = run_fake(&gate, scenario, Duration::from_secs(2));
        assert_eq!(result["kind"], "failed", "{scenario}: {result}");
        assert!(result["selected"].is_null());
        assert_eq!(
            run_fake(&gate, "success", Duration::from_secs(2))["kind"],
            "files"
        );
    }
}

#[test]
fn clipboard_process_start_failure_releases_gate() {
    let gate = ClipboardReadGate::default();
    let result = supervise(
        ImageReadMode::PreferPng,
        Duration::ZERO,
        Duration::from_secs(1),
        &gate,
        |path, _| Ok(Command::new(path.with_file_name("does-not-exist"))),
    );
    assert_eq!(result["kind"], "failed");
    assert_eq!(result["reason"], "worker-start-failed");
    assert_eq!(
        run_fake(&gate, "success", Duration::from_secs(2))["kind"],
        "files"
    );
}

#[test]
fn clipboard_process_gate_rejects_concurrent_request_without_spawning() {
    let gate = Arc::new(ClipboardReadGate::default());
    let barrier = Arc::new(Barrier::new(2));
    let worker_gate = Arc::clone(&gate);
    let worker_barrier = Arc::clone(&barrier);
    let request = thread::spawn(move || {
        supervise(
            ImageReadMode::PreferPng,
            Duration::ZERO,
            Duration::from_millis(150),
            &worker_gate,
            |path, _| {
                worker_barrier.wait();
                fake_command(path, "stall-first")
            },
        )
    });
    barrier.wait();
    let result = supervise(
        ImageReadMode::PreferPng,
        Duration::ZERO,
        Duration::from_secs(1),
        &gate,
        |_, _| panic!("concurrent request must not launch another child"),
    );
    assert_eq!(result["reason"], "read-already-active");
    let first = request.join().unwrap();
    assert_eq!(first["workerReaped"], true);
    assert_eq!(
        run_fake(&gate, "success", Duration::from_secs(2))["kind"],
        "files"
    );
}

#[test]
fn clipboard_focus_guard_is_outside_read_budget_but_holds_permission() {
    let gate = Arc::new(ClipboardReadGate::default());
    let worker_gate = Arc::clone(&gate);
    let request = thread::spawn(move || {
        supervise(
            ImageReadMode::PreferPng,
            Duration::from_millis(80),
            Duration::from_secs(2),
            &worker_gate,
            |path, _| fake_command(path, "success"),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while gate.state.load(Ordering::Acquire) == IDLE {
        assert!(
            Instant::now() < deadline,
            "first request did not acquire gate"
        );
        thread::yield_now();
    }
    assert!(
        gate.acquire().is_err(),
        "focus protection must own the permit"
    );
    let result = request.join().unwrap();
    assert_eq!(result["kind"], "files");
    assert!(result["totalMs"].as_f64().unwrap() >= 80.0);
    assert!(result["totalMs"].as_f64().unwrap() - result["supervisorMs"].as_f64().unwrap() >= 79.0);
}

#[test]
fn clipboard_cleanup_failure_poisons_future_reads() {
    let gate = ClipboardReadGate::default();
    let retained_path = Mutex::new(None);
    let result = supervise(
        ImageReadMode::PreferPng,
        Duration::ZERO,
        Duration::from_secs(2),
        &gate,
        |path, _| {
            // Deterministic filesystem cleanup failure without a live worker:
            // the reserved file name is a directory, which remove_file rejects.
            fs::create_dir(path)?;
            *retained_path.lock().unwrap() = Some(path.to_owned());
            Ok(Command::new(path.join("absent-worker")))
        },
    );
    assert_eq!(result["reason"], "result-cleanup-failed");
    let path = retained_path.into_inner().unwrap().unwrap();
    fs::remove_dir(&path).unwrap();
    fs::remove_dir(path.parent().unwrap()).unwrap();
    assert_eq!(
        run_fake(&gate, "success", Duration::from_secs(1))["reason"],
        "cleanup-failed-gate-poisoned"
    );
}

#[test]
fn clipboard_unwind_reaps_child_before_releasing_gate() {
    let gate = ClipboardReadGate::default();
    let directory = ResultDirectory::new().unwrap();
    let pid = Mutex::new(None);
    let panicked = std::panic::catch_unwind(|| {
        let _permit = gate.acquire().unwrap();
        let mut command = fake_command(&directory.result, "stall-first").unwrap();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().unwrap();
        *pid.lock().unwrap() = Some(child.id());
        let _owned = OwnedChild {
            child,
            gate: &gate,
            reaped: false,
        };
        panic!("simulate supervisor unwinding while a child is alive");
    });
    assert!(panicked.is_err());
    #[cfg(target_os = "linux")]
    assert!(!PathBuf::from(format!("/proc/{}", pid.into_inner().unwrap().unwrap())).exists());
    assert_eq!(
        run_fake(&gate, "success", Duration::from_secs(2))["kind"],
        "files"
    );
}

#[test]
fn clipboard_private_protocol_uses_create_new_and_private_modes() {
    let directory = ResultDirectory::new().unwrap();
    let file = create_result(&directory.result).unwrap();
    assert!(
        create_result(&directory.result).is_err(),
        "must not overwrite any existing result"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&directory.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    }
    drop(file);
    directory.cleanup().unwrap();
}

#[test]
fn clipboard_poison_cannot_be_cleared_by_releasing_permission() {
    let gate = ClipboardReadGate::default();
    let permit = gate.acquire().unwrap();
    gate.poison();
    drop(permit);
    let result = supervise(
        ImageReadMode::PreferPng,
        Duration::ZERO,
        Duration::from_secs(1),
        &gate,
        |_, _| panic!("poisoned gate must not launch a child"),
    );
    assert_eq!(result["kind"], "failed");
    assert_eq!(result["reason"], "cleanup-failed-gate-poisoned");
}

#[test]
fn clipboard_retry_discards_valid_but_over_budget_attempt() {
    let result = retry_reads(Duration::from_millis(10), Duration::ZERO, || {
        thread::sleep(Duration::from_millis(20));
        success()
    });
    assert_eq!(result["kind"], "unresolved");
    assert!(result["selected"].is_null());
    assert!(result["lastAttempt"]["selected"].is_null());
    assert_eq!(result["lastAttempt"]["outcome"], "late-discarded");
}
