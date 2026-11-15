use super::*;
use std::{cell::RefCell, collections::VecDeque, time::Duration};

#[derive(Default)]
struct Backend {
    calls: RefCell<Vec<&'static str>>,
    counts: RefCell<VecDeque<Option<i64>>>,
    files: Vec<String>,
    pngs: RefCell<VecDeque<Result<Vec<u8>, String>>>,
    fallback: bool,
    marker: bool,
    allow_formats: bool,
}

impl ClipboardBackend for Backend {
    fn sequence(&self) -> Option<i64> {
        self.calls.borrow_mut().push("sequence");
        self.counts.borrow_mut().pop_front().unwrap_or(Some(7))
    }
    fn files(&self) -> Result<Vec<String>, String> {
        self.calls.borrow_mut().push("files");
        Ok(self.files.clone())
    }
    fn png(&self) -> Result<Vec<u8>, String> {
        self.calls.borrow_mut().push("png");
        self.pngs
            .borrow_mut()
            .pop_front()
            .unwrap_or(Err("nil".to_owned()))
    }
    fn image(&self) -> Result<RustImageData, String> {
        self.calls.borrow_mut().push("image");
        if self.fallback {
            RustImageData::from_bytes(include_bytes!("../fixtures/rgba.png"))
                .map_err(|e| e.to_string())
        } else {
            Err("nil".to_owned())
        }
    }
    fn text(&self) -> Result<String, String> {
        self.calls.borrow_mut().push("text");
        Ok(if self.marker {
            "RapidRAW:adjustments"
        } else {
            "ordinary text"
        }
        .to_owned())
    }
    fn formats(&self) -> Result<Vec<String>, String> {
        assert!(
            self.allow_formats,
            "guarded read must not enumerate formats"
        );
        self.calls.borrow_mut().push("formats");
        Ok(Vec::new())
    }
}

fn png() -> Vec<u8> {
    include_bytes!("../fixtures/rgba.png").to_vec()
}

#[test]
fn clipboard_files_skip_every_image_text_and_format_probe_in_all_modes() {
    for mode in [
        ImageReadMode::Compare,
        ImageReadMode::PreferPng,
        ImageReadMode::Reencode,
    ] {
        for diagnostic in [true, false] {
            let backend = Backend {
                files: vec!["/tmp/照片 [1].NEF".into(), "/tmp/a directory".into()],
                fallback: true,
                pngs: RefCell::new([Ok(png())].into()),
                ..Backend::default()
            };
            let result = read_snapshot(&backend, mode, diagnostic);
            assert_eq!(result["kind"], "files");
            assert_eq!(result["selected"]["paths"], json!(backend.files));
            assert!(result["image"].is_null());
            assert!(result["text"].is_null());
            assert_eq!(*backend.calls.borrow(), ["sequence", "files", "sequence"]);
        }
    }
}

#[test]
fn clipboard_changed_count_discards_even_valid_files_and_images() {
    for files in [Vec::new(), vec!["/tmp/source.jpg".to_owned()]] {
        let backend = Backend {
            files,
            counts: RefCell::new([Some(7), Some(8)].into()),
            pngs: RefCell::new([Ok(png())].into()),
            ..Backend::default()
        };
        let result = read_snapshot(&backend, ImageReadMode::PreferPng, false);
        assert_eq!(result["outcome"], "invalidated");
        assert_eq!(result["kind"], "unresolved");
        assert!(result["selected"].is_null());
    }
}

#[test]
fn clipboard_same_count_nil_retries_every_read_step_then_accepts_png() {
    let backend = Backend {
        pngs: RefCell::new([Err("nil".into()), Err("nil".into()), Ok(png())].into()),
        marker: true,
        ..Backend::default()
    };
    let result = crate::clipboard_read::retry_reads(Duration::from_secs(1), Duration::ZERO, || {
        read_snapshot(&backend, ImageReadMode::PreferPng, false)
    });
    assert_eq!(result["kind"], "image");
    assert_eq!(result["attempts"], 3);
    assert_eq!(
        *backend.calls.borrow(),
        [
            "sequence", "files", "png", "image", "text", "sequence", "sequence", "files", "png",
            "image", "text", "sequence", "sequence", "files", "png", "sequence",
        ]
    );
}

#[test]
fn clipboard_marker_or_empty_never_becomes_completion() {
    for marker in [false, true] {
        let backend = Backend {
            marker,
            ..Backend::default()
        };
        let result = crate::clipboard_read::retry_reads(
            Duration::from_millis(15),
            Duration::from_millis(2),
            || read_snapshot(&backend, ImageReadMode::PreferPng, false),
        );
        assert_eq!(result["kind"], "unresolved");
        assert!(result["attempts"].as_u64().unwrap() >= 2);
        assert!(result["selected"].is_null());
        assert_eq!(
            result["lastAttempt"]["text"]["value"]["adjustmentsMarker"],
            marker
        );
    }
}

#[test]
fn clipboard_tiff_fallback_and_invalid_png_are_distinguished() {
    let backend = Backend {
        fallback: true,
        ..Backend::default()
    };
    let result = read_snapshot(&backend, ImageReadMode::PreferPng, false);
    assert_eq!(result["kind"], "image");
    assert_eq!(result["selected"]["method"], "decoded-reencoded");

    let backend = Backend {
        pngs: RefCell::new([Ok(b"not a png".to_vec())].into()),
        ..Backend::default()
    };
    let result = crate::clipboard_read::retry_reads(
        Duration::from_millis(10),
        Duration::from_millis(10),
        || read_snapshot(&backend, ImageReadMode::PreferPng, false),
    );
    assert_eq!(result["kind"], "failed");
    assert!(result["selected"].is_null());
}

#[test]
fn clipboard_direct_png_precedes_diagnostic_formats_and_does_not_depend_on_them() {
    let backend = Backend {
        pngs: RefCell::new([Ok(png())].into()),
        allow_formats: true,
        ..Backend::default()
    };
    let result = read_snapshot(&backend, ImageReadMode::PreferPng, true);
    assert_eq!(result["kind"], "image");
    assert_eq!(result["formats"]["value"], json!([]));
    let calls = backend.calls.borrow();
    assert!(calls.iter().position(|c| *c == "png") < calls.iter().position(|c| *c == "formats"));
}

#[test]
fn clipboard_unsequenced_diagnostics_do_not_claim_atomic_snapshot() {
    let backend = Backend {
        counts: RefCell::new([None, None].into()),
        files: vec!["/tmp/example.png".into()],
        ..Backend::default()
    };
    let result = read_snapshot(&backend, ImageReadMode::PreferPng, false);
    assert_eq!(result["kind"], "files");
    assert_eq!(result["sequenceChecked"], false);
    assert_eq!(result["atomicSnapshot"], false);
}

#[test]
fn clipboard_malformed_nonempty_png_never_calls_valid_fallback_in_guarded_modes() {
    for mode in [ImageReadMode::Compare, ImageReadMode::PreferPng] {
        let backend = Backend {
            pngs: RefCell::new([Ok(b"not a PNG".to_vec())].into()),
            fallback: true,
            marker: true,
            ..Backend::default()
        };
        let result =
            crate::clipboard_read::retry_reads(Duration::from_secs(1), Duration::ZERO, || {
                read_snapshot(&backend, mode, false)
            });
        assert_eq!(result["kind"], "failed");
        assert_eq!(result["attempts"], 1);
        assert_eq!(result["invalidImageData"], true);
        assert!(result["selected"].is_null());
        assert_eq!(
            *backend.calls.borrow(),
            ["sequence", "files", "png", "sequence"]
        );
    }
}

#[test]
fn clipboard_empty_png_is_not_known_corruption_and_can_retry_or_use_tiff() {
    let backend = Backend {
        pngs: RefCell::new([Ok(Vec::new()), Ok(png())].into()),
        ..Backend::default()
    };
    let first = read_snapshot(&backend, ImageReadMode::PreferPng, false);
    assert_eq!(first["invalidImageData"], false);
    assert_eq!(first["outcome"], "retry");
    let second = read_snapshot(&backend, ImageReadMode::PreferPng, false);
    assert_eq!(second["kind"], "image");

    let backend = Backend {
        pngs: RefCell::new([Ok(Vec::new())].into()),
        fallback: true,
        ..Backend::default()
    };
    let result = read_snapshot(&backend, ImageReadMode::PreferPng, false);
    assert_eq!(result["kind"], "image");
    assert_eq!(result["selected"]["method"], "decoded-reencoded");
    assert_eq!(result["invalidImageData"], false);
}

#[test]
fn clipboard_diagnostic_compare_can_measure_fallback_but_is_labelled_diagnostic_only() {
    let backend = Backend {
        pngs: RefCell::new([Ok(b"not a PNG".to_vec())].into()),
        fallback: true,
        allow_formats: true,
        ..Backend::default()
    };
    let result = read_snapshot(&backend, ImageReadMode::Compare, true);
    assert_eq!(result["diagnosticOnly"], true);
    assert_eq!(result["rawPng"]["ok"], false);
    assert_eq!(result["image"]["ok"], true);
}

#[test]
fn clipboard_corruption_from_a_changed_sequence_is_discarded_before_failure() {
    let backend = Backend {
        counts: RefCell::new([Some(7), Some(8), Some(8), Some(8)].into()),
        pngs: RefCell::new([Ok(b"not a PNG".to_vec()), Ok(png())].into()),
        fallback: true,
        ..Backend::default()
    };
    let result = crate::clipboard_read::retry_reads(Duration::from_secs(1), Duration::ZERO, || {
        read_snapshot(&backend, ImageReadMode::PreferPng, false)
    });
    assert_eq!(result["kind"], "image");
    assert_eq!(result["attempts"], 2);
    assert!(!backend.calls.borrow().contains(&"image"));
}
