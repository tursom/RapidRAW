use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Instant;

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

/// Called only after the user requests a read, on a blocking worker.
/// Each format is attempted independently: an unavailable format is recorded as an error.
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
                "contextError": error.to_string(),
                "totalMs": started.elapsed().as_secs_f64() * 1000.0,
            });
        }
    };
    let context_ms = started.elapsed().as_secs_f64() * 1000.0;
    let formats = measured(|| {
        context
            .available_formats()
            .map(|formats| json!(formats))
            .map_err(|error| error.to_string())
    });
    let files = measured(|| {
        context
            .get_files()
            .map(|files| json!(files))
            .map_err(|error| error.to_string())
    });
    // Probe the native PNG name directly. Enumeration is diagnostic, never a gate.
    let raw_png = (mode != ImageReadMode::Reencode).then(|| {
        measured(|| {
            let read_started = Instant::now();
            let bytes = context
                .get_buffer(png_format())
                .map_err(|error| error.to_string())?;
            let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
            let mut info = inspect_png(&bytes)?;
            info["readMs"] = json!(read_ms);
            Ok(info)
        })
    });
    let raw_ok = raw_png.as_ref().is_some_and(|value| value["ok"] == true);
    let image = (mode != ImageReadMode::PreferPng || !raw_ok).then(|| {
        measured(|| {
            let read_started = Instant::now();
            let image = context.get_image().map_err(|error| error.to_string())?;
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
    let text = measured(|| {
        let text = context.get_text().map_err(|error| error.to_string())?;
        Ok(json!({
            "bytes": text.len(),
            "preview": text.chars().take(512).collect::<String>(),
            "adjustmentsMarker": text == "RapidRAW:adjustments",
        }))
    });
    json!({
        "schema": 2, "build": build_metadata(), "imageMode": mode.as_str(),
        "contextMs": context_ms,
        "formats": formats,
        "files": files,
        "image": image,
        "rawPngFormat": png_format(), "rawPng": raw_png,
        "selected": selected, "sameRgba8": same_rgba8,
        "text": text,
        "totalMs": started.elapsed().as_secs_f64() * 1000.0,
        "note": "Sequential probes, not an atomic clipboard snapshot. Keep the clipboard unchanged. Compare runs both paths; totalMs is not a PNG-first latency. Hashing/full decode are diagnostic validation; no image payload is transferred through IPC or saved.",
    })
}

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
