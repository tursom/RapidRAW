//! Windows-only diagnostic receiver; all COM objects stay on the WebView UI thread.
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler, take_pwstr,
};
use windows::core::{Interface, PWSTR};

const EVENT: &str = "spike-additional-paths";

// Release the COM-owned output string even when the property getter fails.
fn string_property(
    get: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut raw = PWSTR::null();
    let result = get(&mut raw);
    let text = take_pwstr(raw);
    result?;
    Ok(text)
}

fn receive(
    args: Option<ICoreWebView2WebMessageReceivedEventArgs>,
) -> windows::core::Result<Option<Value>> {
    let Some(args) = args else { return Ok(None) };
    // This experiment uses embedded assets and the default Windows HTTP custom protocol.
    let source = string_property(|out| unsafe { args.Source(out) })?;
    let origin = tauri::Url::parse(&source)
        .ok()
        .map(|url| url.origin().ascii_serialization());
    if origin.as_deref() != Some("http://tauri.localhost") {
        return Ok(None);
    }
    let text = string_property(|out| unsafe { args.TryGetWebMessageAsString(out) })?;
    let Ok(message) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };
    if message.get("type").and_then(Value::as_str) != Some("intake-spike") {
        return Ok(None);
    }
    let args = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?;
    let objects = unsafe { args.AdditionalObjects()? };
    let mut count = 0;
    unsafe { objects.Count(&mut count)? };
    let mut paths = Vec::new();
    for index in 0..count {
        let object = unsafe { objects.GetValueAtIndex(index)? };
        let file = object.cast::<ICoreWebView2File>()?;
        paths.push(string_property(|out| unsafe { file.Path(out) })?);
    }
    Ok(Some(json!({
        "ok": true, "phase": "receive", "source": source,
        "context": message.get("context"), "count": count, "paths": paths,
    })))
}

pub fn install(window: tauri::WebviewWindow) -> Result<(), String> {
    let sink = window.app_handle().clone();
    window
        .with_webview(move |webview| {
            let events = sink.clone();
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let payload = match receive(args) {
                    Ok(Some(payload)) => payload,
                    Ok(None) => return Ok(()),
                    Err(error) => {
                        json!({ "ok": false, "phase": "receive", "error": error.to_string() })
                    }
                };
                if let Err(error) = events.emit_to("main", EVENT, payload) {
                    eprintln!("{EVENT}: {error}");
                }
                Ok(())
            }));
            let registration = (|| unsafe {
                let core = webview.controller().CoreWebView2()?;
                let mut token = 0;
                // WebView2 owns this one subscription until the experiment window closes.
                core.add_WebMessageReceived(&handler, &mut token)
            })();
            let payload = match registration {
                Ok(()) => json!({ "ok": true, "phase": "register" }),
                Err(error) => {
                    json!({ "ok": false, "phase": "register", "error": error.to_string() })
                }
            };
            if let Err(error) = sink.emit_to("main", EVENT, payload) {
                eprintln!("{EVENT}: {error}");
            }
        })
        .map_err(|error| error.to_string())
}
