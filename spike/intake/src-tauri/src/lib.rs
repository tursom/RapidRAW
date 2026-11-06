use clipboard_rs::{Clipboard, ClipboardContext, common::RustImage};
use serde_json::{Value, json};
use std::time::Instant;

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
    let started = Instant::now();
    let context = match ClipboardContext::new() {
        Ok(context) => context,
        Err(error) => {
            return json!({
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
    let image = measured(|| {
        let read_started = Instant::now();
        let image = context.get_image().map_err(|error| error.to_string())?;
        let read_ms = read_started.elapsed().as_secs_f64() * 1000.0;
        let (width, height) = image.get_size();
        let png = measured(|| {
            image
                .to_png()
                .map(|png| json!({ "bytes": png.get_bytes().len() }))
                .map_err(|error| error.to_string())
        });
        Ok(json!({ "width": width, "height": height, "readMs": read_ms, "png": png }))
    });
    let text = measured(|| {
        let text = context.get_text().map_err(|error| error.to_string())?;
        Ok(json!({
            "bytes": text.len(),
            "preview": text.chars().take(512).collect::<String>(),
            "adjustmentsMarker": text == "RapidRAW:adjustments",
        }))
    });
    json!({
        "contextMs": context_ms,
        "formats": formats,
        "files": files,
        "image": image,
        "text": text,
        "totalMs": started.elapsed().as_secs_f64() * 1000.0,
        "note": "Sequential probes, not an atomic clipboard snapshot. Keep the clipboard unchanged during a read. image.elapsedMs includes PNG encoding.",
    })
}
