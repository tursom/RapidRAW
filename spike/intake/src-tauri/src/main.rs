#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{Value, json};
use std::{io::Write, time::SystemTime};
use tauri::Manager;

#[cfg(windows)]
mod additional_objects;

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
    })
}

#[tauri::command]
async fn read_system_clipboard(image_mode: Option<String>) -> Result<Value, String> {
    let mode =
        rapidraw_intake_spike::ImageReadMode::try_from(image_mode.as_deref().unwrap_or("compare"))?;
    tauri::async_runtime::spawn_blocking(move || {
        rapidraw_intake_spike::read_clipboard_with_mode(mode)
    })
    .await
    .map_err(|error| error.to_string())
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            environment,
            read_system_clipboard,
            save_report,
            install_additional_receiver
        ])
        .run(tauri::generate_context!())
        .expect("failed to run intake spike");
}
