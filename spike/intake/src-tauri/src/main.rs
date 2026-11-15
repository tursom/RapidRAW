#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tauri::Manager;

#[cfg(windows)]
mod additional_objects;
#[cfg(target_os = "macos")]
mod macos_drag;

const FOCUS_GUARD: Duration = Duration::from_millis(500);

struct ReadState {
    gate: Arc<rapidraw_intake_spike::clipboard_read::ClipboardReadGate>,
    focused_at: Mutex<Instant>,
    web_hash_busy: Arc<AtomicBool>,
    #[cfg(feature = "original-images")]
    original_image_busy: Arc<AtomicBool>,
}

impl Default for ReadState {
    fn default() -> Self {
        Self {
            gate: Arc::default(),
            focused_at: Mutex::new(Instant::now()),
            web_hash_busy: Arc::default(),
            #[cfg(feature = "original-images")]
            original_image_busy: Arc::default(),
        }
    }
}

struct ImagePermit(Arc<AtomicBool>);

impl ImagePermit {
    fn acquire(busy: Arc<AtomicBool>) -> Result<Self, String> {
        busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "An image request is already running".to_owned())?;
        Ok(Self(busy))
    }
}

impl Drop for ImagePermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
async fn hash_web_drop_bytes(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, ReadState>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let permit = ImagePermit::acquire(state.web_hash_busy.clone())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes)
            if !bytes.is_empty() && bytes.len() <= 128 * 1024 * 1024 =>
        {
            bytes.clone()
        }
        _ => return Err("Expected binary web-image bytes within the 128 MiB limit".to_owned()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        format!("{:x}", Sha256::digest(bytes))
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn install_macos_drag_bridge(window: tauri::WebviewWindow) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        macos_drag::install(window).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("The native drag bridge requires macOS".to_owned())
    }
}

#[tauri::command]
async fn arm_macos_drop_capture(
    window: tauri::WebviewWindow,
    capture_id: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        macos_drag::arm(window, capture_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, capture_id);
        Err("The native drag bridge requires macOS".to_owned())
    }
}

#[tauri::command]
async fn finish_macos_drop_capture(
    window: tauri::WebviewWindow,
    capture_id: String,
    html_drop_id: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        macos_drag::finish_html(window, capture_id, html_drop_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, capture_id, html_drop_id);
        Err("The native drag bridge requires macOS".to_owned())
    }
}

#[tauri::command]
async fn macos_drop_capture_status(
    window: tauri::WebviewWindow,
    capture_id: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        macos_drag::status(window, capture_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, capture_id);
        Err("The native drag bridge requires macOS".to_owned())
    }
}

#[tauri::command]
async fn install_additional_receiver(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        additional_objects::install(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("AdditionalObjects requires Windows WebView2".to_owned())
    }
}

#[tauri::command]
fn environment(app: tauri::AppHandle) -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "nativeDragDrop": app.config().app.windows[0].drag_drop_enabled,
        "clipboardLibrary": "clipboard-rs 0.3.5",
        "debug": cfg!(debug_assertions),
        "build": rapidraw_intake_spike::build_metadata(),
        "clipboardReadPolicy": {
            "focusGuardMs": 500, "budgetMs": 3000, "retryMs": 200,
            "parametersProvisional": true, "macHardwareVerified": false,
        },
        "originalImageAcquisition": "explicit-url-request; no automatic download",
        "originalImageUrlReadEnabled": cfg!(feature = "original-images"),
    })
}

#[tauri::command]
async fn read_system_clipboard(
    image_mode: Option<String>,
    state: tauri::State<'_, ReadState>,
) -> Result<Value, String> {
    let mode = rapidraw_intake_spike::ImageReadMode::try_from(
        image_mode.as_deref().unwrap_or("prefer-png"),
    )?;
    let guard = state
        .focused_at
        .lock()
        .map(|at| FOCUS_GUARD.saturating_sub(at.elapsed()))
        .unwrap_or(FOCUS_GUARD);
    let gate = state.gate.clone();
    tauri::async_runtime::spawn_blocking(move || {
        rapidraw_intake_spike::clipboard_read::read_guarded(mode, guard, &gate)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_original_image_url(
    url: String,
    state: tauri::State<'_, ReadState>,
) -> Result<Value, String> {
    #[cfg(feature = "original-images")]
    {
        let permit = ImagePermit::acquire(state.original_image_busy.clone())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            rapidraw_intake_spike::original_image::read_original_image(&url)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(feature = "original-images"))]
    {
        let _ = (url, state);
        Err("This build does not include original URL image reads".to_owned())
    }
}

#[tauri::command]
fn save_report(app: tauri::AppHandle, report: Value) -> Result<String, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("results");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = directory.join(format!("intake-spike-{timestamp}.json"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn main() {
    // The same signed executable owns the worker. Do this before Tauri/AppKit
    // starts a second application window or registers any input handlers.
    if let Some(code) = rapidraw_intake_spike::clipboard_read::worker_entry() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .manage(ReadState::default())
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::Focused(true))
                && let Some(state) = window.try_state::<ReadState>()
                && let Ok(mut focused_at) = state.focused_at.lock()
            {
                *focused_at = Instant::now();
            }
        })
        .invoke_handler(tauri::generate_handler![
            environment,
            read_system_clipboard,
            save_report,
            install_additional_receiver,
            install_macos_drag_bridge,
            arm_macos_drop_capture,
            finish_macos_drop_capture,
            macos_drop_capture_status,
            hash_web_drop_bytes,
            read_original_image_url
        ])
        .run(tauri::generate_context!())
        .expect("failed to run intake spike");
}
