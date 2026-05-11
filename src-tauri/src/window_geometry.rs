/// Window geometry persistence for restoring position/size across launches.
use crate::cache::CacheStore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Listener, LogicalPosition, LogicalSize, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "savedAt")]
    pub saved_at: u64,
}

/// Shared state for debounced window geometry writes
pub struct GeometryState {
    cache: CacheStore<WindowGeometry>,
    pending: Mutex<Option<(WindowGeometry, Instant)>>,
}

impl Default for GeometryState {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryState {
    pub fn new() -> Self {
        Self {
            cache: CacheStore::new("windowGeometry"),
            pending: Mutex::new(None),
        }
    }

    /// Load cached geometry
    pub fn load(&self) -> Option<WindowGeometry> {
        self.cache.load()
    }

    /// Save geometry with debouncing (250ms)
    pub fn save_debounced(&self, geometry: WindowGeometry) {
        let mut pending = self.pending.lock().unwrap();
        *pending = Some((geometry, Instant::now()));
    }

    /// Flush pending writes if debounce time has elapsed
    pub fn flush_if_ready(&self) {
        let mut pending = self.pending.lock().unwrap();
        if let Some((geometry, timestamp)) = pending.as_ref() {
            if timestamp.elapsed() >= Duration::from_millis(250) {
                self.cache.save(geometry);
                *pending = None;
            }
        }
    }
}

/// Apply cached geometry to a window on startup
pub fn apply_cached_geometry(app: &AppHandle, window_label: &str) {
    let state = Arc::new(GeometryState::new());

    if let Some(geometry) = state.load() {
        if let Some(window) = app.get_webview_window(window_label) {
            // Apply size
            let _ = window.set_size(LogicalSize::new(geometry.width, geometry.height));

            // Apply position
            let _ = window.set_position(LogicalPosition::new(geometry.x, geometry.y));
        }
    }
}

/// Start listening for window events and persist geometry changes
pub fn start_geometry_tracking(app: AppHandle, window_label: String) {
    let state = Arc::new(GeometryState::new());

    // Clone everything needed for the resize listener
    let state_resize = state.clone();
    let label_resize = window_label.clone();
    let app_resize = app.clone();

    // Listen for resize events
    let _ = app.listen("tauri://resize", move |_event| {
        if let Some(window) = app_resize.get_webview_window(&label_resize) {
            if let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) {
                let geometry = WindowGeometry {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    saved_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                state_resize.save_debounced(geometry);
            }
        }
    });

    // Clone everything needed for the move listener
    let state_move = state.clone();
    let label_move = window_label.clone();
    let app_move = app.clone();
    let app_move_inner = app_move.clone();

    // Listen for move events
    let _ = app_move.listen("tauri://move", move |_event| {
        if let Some(window) = app_move_inner.get_webview_window(&label_move) {
            if let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) {
                let geometry = WindowGeometry {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    saved_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                state_move.save_debounced(geometry);
            }
        }
    });

    // Spawn a background task to flush pending writes
    let state_flush = state.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        state_flush.flush_if_ready();
    });
}
