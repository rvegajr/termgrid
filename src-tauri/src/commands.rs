use crate::pty::traits::*;
use crate::state::AppState;
use serde::Serialize;
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
pub struct CreatePaneResult {
    pub pane_id: String,
}

#[tauri::command]
pub fn list_shells(state: State<AppState>) -> Vec<ShellInfo> {
    state.shell_detector.available_shells()
}

#[tauri::command]
pub fn default_shell(state: State<AppState>) -> ShellInfo {
    state.shell_detector.default_shell()
}

#[derive(Clone, Serialize)]
struct PtyOutputEvent {
    pane_id: String,
    data: Vec<u8>,
}

#[tauri::command]
pub fn create_pane(
    app: AppHandle,
    state: State<AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CreatePaneResult, String> {
    let pane_id = uuid::Uuid::new_v4().to_string();
    let shell_path = shell.unwrap_or_else(|| state.shell_detector.default_shell().path);
    let cwd = cwd.unwrap_or_else(|| {
        dirs_next::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    });

    state
        .pty_spawner
        .spawn(
            &pane_id,
            &shell_path,
            &cwd,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
        )
        .map_err(|e| e.to_string())?;

    // Start streaming PTY output to frontend
    let rx = state
        .pty_reader
        .subscribe(&pane_id)
        .map_err(|e| e.to_string())?;

    let pid = pane_id.clone();
    thread::spawn(move || {
        while let Ok(data) = rx.recv() {
            let _ = app.emit(
                "pty-output",
                PtyOutputEvent {
                    pane_id: pid.clone(),
                    data,
                },
            );
        }
    });

    Ok(CreatePaneResult { pane_id })
}

#[tauri::command]
pub fn write_pane(state: State<AppState>, pane_id: String, data: String) -> Result<(), String> {
    state
        .pty_writer
        .write(&pane_id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_pane(
    state: State<AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty_resizer
        .resize(&pane_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_pane(state: State<AppState>, pane_id: String) -> Result<(), String> {
    state
        .pty_lifecycle
        .kill(&pane_id)
        .map_err(|e| e.to_string())
}
