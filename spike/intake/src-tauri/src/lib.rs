use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Instant;

pub mod clipboard_read;
pub mod drop_capture;
#[cfg(feature = "original-images")]
pub mod original_image;
pub use clipboard_read::{
    ClipboardReadGate, PROVISIONAL_FOCUS_GUARD, PROVISIONAL_READ_BUDGET,
    PROVISIONAL_RETRY_INTERVAL, read_guarded, worker_entry,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ImageReadMode {
    Compare,
    PreferPng,
    Reencode,
}

impl ImageReadMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compare => "compare",
            Self::PreferPng => "prefer-png",
            Self::Reencode => "reencode",
        }
    }
}

impl TryFrom<&str> for ImageReadMode {
    type Error = String;

    fn try_from(mode: &str) -> Result<Self, Self::Error> {
        match mode {
            "compare" => Ok(Self::Compare),
            "prefer-png" => Ok(Self::PreferPng),
            "reencode" => Ok(Self::Reencode),
            _ => Err("imageMode must be compare, prefer-png, or reencode".to_owned()),
        }
    }
}

pub fn build_metadata() -> Value {
    json!({
        "profile": env!("SPIKE_CARGO_PROFILE"),
        "optLevel": env!("SPIKE_OPT_LEVEL"),
        "debugAssertions": cfg!(debug_assertions),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

fn png_format() -> &'static str {
    if cfg!(target_os = "windows") {
        "PNG"
    } else if cfg!(target_os = "macos") {
        "public.png"
    } else {
        "image/png"
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn rgba8_hash(image: &RustImageData) -> Result<String, String> {
    let rgba = image.to_rgba8().map_err(|error| error.to_string())?;
    Ok(sha256(rgba.as_raw()))
}

fn inspect_png(bytes: &[u8]) -> Result<Value, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Clipboard PNG buffer does not have a PNG signature".to_owned());
    }
    let started = Instant::now();
    let image = RustImageData::from_bytes(bytes).map_err(|error| error.to_string())?;
    let decode_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (width, height) = image.get_size();
    let started = Instant::now();
    let rgba_hash = rgba8_hash(&image)?;
    let pixel_hash_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let byte_hash = sha256(bytes);
    Ok(json!({
        "width": width, "height": height, "bytes": bytes.len(),
        "sha256": byte_hash, "byteHashMs": started.elapsed().as_secs_f64() * 1000.0,
        "rgba8Sha256": rgba_hash, "pixelHashMs": pixel_hash_ms, "decodeMs": decode_ms,
    }))
}

fn measured(operation: impl FnOnce() -> Result<Value, String>) -> Value {
    let started = Instant::now();
    let result = operation();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(value) => json!({ "ok": true, "elapsedMs": elapsed_ms, "value": value }),
        Err(error) => json!({ "ok": false, "elapsedMs": elapsed_ms, "error": error }),
    }
}

/// Explicit one-shot diagnostics. Use `read_guarded` for a bounded user read.
pub fn read_clipboard() -> Value {
    read_clipboard_with_mode(ImageReadMode::Compare)
}

pub fn read_clipboard_with_mode(mode: ImageReadMode) -> Value {
    let started = Instant::now();
    let context = match ClipboardContext::new() {
        Ok(context) => context,
        Err(error) => {
            return json!({
                "schema": 2, "build": build_metadata(), "imageMode": mode.as_str(),
                "contextError": error.to_string(), "kind": "unresolved", "outcome": "retry",
                "totalMs": started.elapsed().as_secs_f64() * 1000.0,
            });
        }
    };
    let context_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut snapshot = read_snapshot(&context, mode, true);
    snapshot["contextMs"] = json!(context_ms);
    snapshot["totalMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    snapshot
}

// The test backend never touches the machine clipboard. Native calls stay in
// the worker for guarded reads, including sequence reads and image validation.
trait ClipboardBackend {
    fn sequence(&self) -> Option<i64>;
    fn files(&self) -> Result<Vec<String>, String>;
    fn png(&self) -> Result<Vec<u8>, String>;
    fn image(&self) -> Result<RustImageData, String>;
    fn text(&self) -> Result<String, String>;
    fn formats(&self) -> Result<Vec<String>, String>;
}

impl ClipboardBackend for ClipboardContext {
    fn sequence(&self) -> Option<i64> {
        clipboard_read::native_sequence()
    }
    fn files(&self) -> Result<Vec<String>, String> {
        self.get_files().map_err(|e| e.to_string())
    }
    fn png(&self) -> Result<Vec<u8>, String> {
        self.get_buffer(png_format()).map_err(|e| e.to_string())
    }
    fn image(&self) -> Result<RustImageData, String> {
        self.get_image().map_err(|e| e.to_string())
    }
    fn text(&self) -> Result<String, String> {
        self.get_text().map_err(|e| e.to_string())
    }
    fn formats(&self) -> Result<Vec<String>, String> {
        self.available_formats().map_err(|e| e.to_string())
    }
}

fn finish_snapshot(
    mut value: Value,
    before: Option<i64>,
    after: Option<i64>,
    started: Instant,
) -> Value {
    value["sequenceBefore"] = json!(before);
    value["sequenceAfter"] = json!(after);
    value["sequenceChecked"] = json!(before.is_some() && after.is_some());
    value["atomicSnapshot"] = json!(false);
    if before != after {
        value["kind"] = json!("unresolved");
        value["outcome"] = json!("invalidated");
        value["selected"] = Value::Null;
    }
    value["totalMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    value
}

fn read_snapshot(context: &impl ClipboardBackend, mode: ImageReadMode, diagnostic: bool) -> Value {
    let started = Instant::now();
    let before = context.sequence();
    let mut snapshot = json!({
        "schema": 2, "build": build_metadata(), "imageMode": mode.as_str(),
        "contextMs": 0.0, "formats": null, "files": null, "image": null,
        "rawPngFormat": png_format(), "rawPng": null, "selected": null,
        "sameRgba8": null, "text": null, "kind": "unresolved", "outcome": "retry",
        "diagnosticOnly": diagnostic,
        "invalidImageData": false,
        "note": "Sequential probes, not an atomic clipboard snapshot. Counts detect changes, not producer completion. No image payload is transferred or saved."
    });
    let files = measured(|| context.files().map(|files| json!(files)));
    let paths = files["value"].as_array().filter(|paths| !paths.is_empty());
    if let Some(paths) = paths {
        snapshot["selected"] = json!({ "method": "files", "paths": paths });
        snapshot["kind"] = json!("files");
        snapshot["outcome"] = json!("success");
        snapshot["files"] = files;
        return finish_snapshot(snapshot, before, context.sequence(), started);
    }
    snapshot["files"] = files;
    // Probe the native PNG name directly. Enumeration is diagnostic, never a gate.
    let mut invalid_image_data = false;
    let raw_png = (mode != ImageReadMode::Reencode).then(|| {
        measured(|| {
            let read_started = Instant::now();
            let bytes = context.png()?;
            let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
            if bytes.is_empty() {
                return Err("PNG representation has no bytes yet".to_owned());
            }
            let mut info = inspect_png(&bytes).inspect_err(|_| invalid_image_data = true)?;
            info["readMs"] = json!(read_ms);
            Ok(info)
        })
    });
    let raw_ok = raw_png.as_ref().is_some_and(|value| value["ok"] == true);
    // Known nonempty malformed PNG must not be masked by a bitmap/TIFF in an
    // input read. Explicit one-shot diagnostics may still compare both paths.
    let image = ((diagnostic || !invalid_image_data)
        && (mode != ImageReadMode::PreferPng || !raw_ok))
        .then(|| {
            measured(|| {
                let read_started = Instant::now();
                let image = context.image()?;
                let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
                let (width, height) = image.get_size();
                let pixel_started = Instant::now();
                let pixel_hash = rgba8_hash(&image)?;
                let pixel_hash_ms = pixel_started.elapsed().as_secs_f64() * 1000.0;
                let encode_started = Instant::now();
                let encoded = image.to_png();
                let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.0;
                let png = match encoded {
                    Ok(png) => {
                        let hash_started = Instant::now();
                        let byte_hash = sha256(png.get_bytes());
                        json!({ "ok": true, "elapsedMs": encode_ms, "value": {
                            "bytes": png.get_bytes().len(), "sha256": byte_hash,
                            "byteHashMs": hash_started.elapsed().as_secs_f64() * 1000.0,
                        }})
                    }
                    Err(error) => {
                        invalid_image_data = true;
                        json!({ "ok": false, "elapsedMs": encode_ms, "error": error.to_string() })
                    }
                };
                Ok(
                    json!({ "width": width, "height": height, "readMs": read_ms, "png": png,
            "rgba8Sha256": pixel_hash, "pixelHashMs": pixel_hash_ms }),
                )
            })
        });
    let selected = if raw_ok {
        let value = &raw_png.as_ref().expect("successful PNG probe")["value"];
        json!({ "method": "raw-png", "bytes": value["bytes"], "sha256": value["sha256"] })
    } else if let Some(image) = image.as_ref().filter(|v| v["value"]["png"]["ok"] == true) {
        let value = &image["value"]["png"]["value"];
        json!({ "method": "decoded-reencoded", "bytes": value["bytes"], "sha256": value["sha256"] })
    } else {
        Value::Null
    };
    let same_rgba8 = raw_png
        .as_ref()
        .and_then(|raw| raw["value"]["rgba8Sha256"].as_str())
        .zip(
            image
                .as_ref()
                .and_then(|image| image["value"]["rgba8Sha256"].as_str()),
        )
        .map(|(raw, encoded)| raw == encoded);
    let text = (diagnostic || (selected.is_null() && !invalid_image_data)).then(|| {
        measured(|| {
            let text = context.text()?;
            Ok(json!({
                "bytes": text.len(),
                "preview": text.chars().take(512).collect::<String>(),
                "adjustmentsMarker": text == "RapidRAW:adjustments",
            }))
        })
    });
    // This optional diagnostic is deliberately after the direct PNG attempt.
    // Guarded reads never enumerate formats, even for terminal classification.
    snapshot["formats"] = if diagnostic {
        measured(|| context.formats().map(|formats| json!(formats)))
    } else {
        Value::Null
    };
    if !selected.is_null() {
        snapshot["kind"] = json!("image");
        snapshot["outcome"] = json!("success");
    } else if invalid_image_data && !diagnostic {
        snapshot["kind"] = json!("failed");
        snapshot["outcome"] = json!("failed");
        snapshot["reason"] = json!("invalid-image-data");
    }
    snapshot["selected"] = selected;
    snapshot["rawPng"] = json!(raw_png);
    snapshot["image"] = json!(image);
    snapshot["sameRgba8"] = json!(same_rgba8);
    snapshot["text"] = json!(text);
    snapshot["invalidImageData"] = json!(invalid_image_data);
    finish_snapshot(snapshot, before, context.sequence(), started)
}

#[cfg(test)]
#[path = "../tests/clipboard_backend/mod.rs"]
mod clipboard_backend_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_png_is_decoded_and_fingerprinted_without_changing_bytes() {
        let bytes = include_bytes!("../tests/fixtures/rgba.png");
        let info = inspect_png(bytes).expect("valid PNG");
        assert_eq!(info["width"], 2);
        assert_eq!(info["height"], 1);
        assert_eq!(info["bytes"], bytes.len());
        assert_eq!(info["sha256"], sha256(bytes));
        assert_eq!(
            info["rgba8Sha256"],
            sha256(&[255, 0, 0, 255, 0, 128, 255, 64])
        );
    }

    #[test]
    fn truncated_or_mislabeled_png_is_rejected() {
        assert!(inspect_png(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(inspect_png(b"\xff\xd8\xffJPEG is not PNG").is_err());
    }

    #[test]
    fn decode_reencode_preserves_normalized_pixels() {
        let bytes = include_bytes!("../tests/fixtures/rgba.png");
        let image = RustImageData::from_bytes(bytes).expect("fixture");
        let encoded = image.to_png().expect("encoded PNG");
        assert_eq!(
            inspect_png(bytes).unwrap()["rgba8Sha256"],
            inspect_png(encoded.get_bytes()).unwrap()["rgba8Sha256"]
        );
    }
}
