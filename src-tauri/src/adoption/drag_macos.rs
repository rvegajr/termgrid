//! **v5:** macOS drag-from-OS-window adoption via Accessibility API.
//!
//! Monitors terminal window positions and detects when they're dragged over
//! TermGrid. When a terminal window overlaps TermGrid's bounds for >500ms,
//! we extract the PID and trigger adoption.
//!
//! **Requirements:**
//! - Accessibility permissions granted to TermGrid (user must approve in
//!   System Preferences → Security & Privacy → Privacy → Accessibility)
//! - App must be signed with a Developer ID certificate
//!
//! **Architecture:**
//! 1. `check_accessibility_permission()` — check if granted
//! 2. `request_accessibility_permission()` — prompt user for grant
//! 3. `start_drag_monitor()` — spawn background thread monitoring window positions
//! 4. `poll_drag_events()` — frontend polls for detected PIDs
//! 5. `stop_drag_monitor()` — stop monitoring

#[cfg(target_os = "macos")]
use core_graphics::display::CGRect;
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
lazy_static::lazy_static! {
    static ref DRAG_STATE: Arc<Mutex<DragState>> = Arc::new(Mutex::new(DragState::default()));
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct DragState {
    monitoring: bool,
    pending_adoption_pid: Option<u32>,
    termgrid_bounds: Option<CGRect>,
}

#[cfg(target_os = "macos")]
#[allow(dead_code)] // Used in production implementation, not in stub
static TERMINAL_APPS: &[&str] = &[
    "Terminal.app",
    "iTerm2",
    "Kitty",
    "Alacritty",
    "Hyper",
    "Warp",
];

/// Check if TermGrid has Accessibility permissions.
///
/// **Stub:** In production, this would call `AXIsProcessTrusted()` from
/// ApplicationServices framework. The full implementation requires FFI
/// bindings like:
/// ```c
/// #import <ApplicationServices/ApplicationServices.h>
/// bool AXIsProcessTrusted(void);
/// ```
///
/// For now, this stub always returns `false` to demonstrate the permission
/// flow. To implement properly:
/// 1. Add `cocoa` or `core-foundation-sys` crate
/// 2. Declare extern "C" function for AXIsProcessTrusted
/// 3. Call it here
#[cfg(target_os = "macos")]
pub fn check_accessibility_permission() -> bool {
    // Stub: always returns false until proper FFI bindings are added
    false
}

/// Request Accessibility permissions. Opens System Preferences to the
/// Accessibility pane so the user can grant permissions manually.
#[cfg(target_os = "macos")]
pub fn request_accessibility_permission() -> Result<(), String> {
    // Open System Preferences → Security & Privacy → Accessibility
    let script = r#"
        tell application "System Preferences"
            reveal anchor "Privacy_Accessibility" of pane id "com.apple.preference.security"
            activate
        end tell
    "#;
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to open System Preferences: {}", e))?;

    if !output.status.success() {
        return Err("Failed to open Accessibility preferences".into());
    }
    Ok(())
}

/// Start monitoring for drag-to-drop events. Spawns a background thread that
/// polls window positions every 100ms.
#[cfg(target_os = "macos")]
pub fn start_drag_monitor(termgrid_bounds: CGRect) -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if state.monitoring {
        return Ok(()); // Already monitoring
    }

    if !check_accessibility_permission() {
        return Err("Accessibility permissions not granted. Please grant access in System Preferences → Security & Privacy → Privacy → Accessibility".into());
    }

    state.monitoring = true;
    state.termgrid_bounds = Some(termgrid_bounds);
    drop(state); // Release lock before spawning thread

    thread::spawn(move || {
        // Main monitoring loop
        loop {
            thread::sleep(Duration::from_millis(100));

            let state = match DRAG_STATE.lock() {
                Ok(s) => s,
                Err(_) => break,
            };

            if !state.monitoring {
                break;
            }
            drop(state);

            // Stub: In a production implementation, this loop would:
            // 1. Call Accessibility API to enumerate all windows:
            //    ```c
            //    AXUIElementRef app = AXUIElementCreateApplication(pid);
            //    CFArrayRef windows;
            //    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &windows);
            //    ```
            // 2. For each window, check:
            //    - If it belongs to a terminal app (via CFBundleIdentifier)
            //    - Get its position/size (kAXPositionAttribute, kAXSizeAttribute)
            //    - Check if it overlaps termgrid_bounds
            // 3. If overlap persists for >500ms, extract the PID of the
            //    *shell process* inside that terminal (not the terminal PID).
            //    This requires calling our existing `enumerate()` logic to
            //    find shell children of the terminal process.
            // 4. Mark that shell PID for adoption via:
            //    ```rust
            //    let mut state = DRAG_STATE.lock().unwrap();
            //    state.pending_adoption_pid = Some(shell_pid);
            //    ```
            //
            // For now, this is a no-op stub. The architecture is sound, but
            // the FFI bindings are non-trivial. Real implementation would use
            // the `cocoa` or `accessibility-sys` crate for proper bindings.
        }
    });

    Ok(())
}

/// Stop monitoring for drag events.
#[cfg(target_os = "macos")]
pub fn stop_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    state.monitoring = false;
    state.pending_adoption_pid = None;
    state.termgrid_bounds = None;
    Ok(())
}

/// Poll for pending drag-to-drop adoption PIDs.
#[cfg(target_os = "macos")]
pub fn poll_drag_events() -> Option<u32> {
    let mut state = DRAG_STATE.lock().ok()?;
    state.pending_adoption_pid.take()
}

// Stubs for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub fn check_accessibility_permission() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility_permission() -> Result<(), String> {
    Err("Accessibility API is only available on macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn start_drag_monitor(_bounds: core_graphics::display::CGRect) -> Result<(), String> {
    Err("Drag monitoring is only supported on macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn stop_drag_monitor() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn poll_drag_events() -> Option<u32> {
    None
}
