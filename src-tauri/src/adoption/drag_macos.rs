//! **v5:** macOS drag-from-OS-window adoption.
//!
//! True drag-rect detection on macOS requires walking the Accessibility tree
//! every frame, which is expensive and needs Accessibility entitlement. The
//! pragmatic equivalent — and what Windows already does — is to detect the
//! foreground-app transition: terminal in front, then TermGrid in front. We
//! treat that pair as a "drag-to-drop" proxy.
//!
//! `AXIsProcessTrusted()` is still surfaced so the UI can correctly tell the
//! user when the upgraded (window-position) path would be available.
//!
//! Architecture:
//! 1. `check_accessibility_permission()` — real `AXIsProcessTrusted` call.
//! 2. `request_accessibility_permission()` — opens System Preferences.
//! 3. `start_drag_monitor(_)` — spawn polling thread (NSWorkspace via
//!    AppleScript, ~250 ms cadence) that watches frontmost-app changes.
//! 4. `poll_drag_events()` — frontend polls for detected shell PIDs.
//! 5. `stop_drag_monitor()` — stop the poller.

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
lazy_static::lazy_static! {
    static ref DRAG_STATE: Arc<Mutex<DragState>> = Arc::new(Mutex::new(DragState::default()));
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct DragState {
    monitoring: bool,
    /// PID of the last terminal-host app seen as frontmost. When TermGrid
    /// becomes frontmost, this is converted to its youngest shell child.
    last_terminal_pid: Option<u32>,
    /// Timestamp of `last_terminal_pid`. We discard stale stash > 5s old
    /// so an old terminal focus from before the user did other things
    /// can't trigger a phantom adoption.
    last_terminal_at: Option<Instant>,
    pending_adoption_pid: Option<u32>,
}

#[cfg(target_os = "macos")]
const TERMINAL_APPS: &[&str] = &[
    "Terminal",
    "iTerm2",
    "iTerm",
    "kitty",
    "Alacritty",
    "Hyper",
    "Warp",
    "WezTerm",
    "Ghostty",
];

#[cfg(target_os = "macos")]
const STALE_MS: u128 = 5_000;

/// Check if TermGrid has Accessibility permissions.
///
/// Direct FFI to ApplicationServices framework's `AXIsProcessTrusted()`.
/// Returns `true` once the user has approved TermGrid in
/// System Settings → Privacy & Security → Accessibility.
///
/// We *still* call this even though the basic drag-by-foreground-switch
/// path doesn't strictly require it — the upgraded path (true window-rect
/// overlap detection) will, and surfacing the permission state lets the UI
/// nudge the user accurately.
#[cfg(target_os = "macos")]
pub fn check_accessibility_permission() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Request Accessibility permissions. Opens System Settings → Privacy &
/// Security → Accessibility. (Modern macOS doesn't allow programmatic
/// permission grant — the user has to flip the toggle themselves.)
#[cfg(target_os = "macos")]
pub fn request_accessibility_permission() -> Result<(), String> {
    // x-apple.systempreferences URL works on macOS 13+. Older versions fall
    // back to the AppleScript path.
    let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    if std::process::Command::new("open")
        .arg(url)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
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

/// Read `(name, pid)` of the frontmost application via AppleScript.
///
/// Costs ~10–20 ms per call. Cheap enough to poll a few times a second.
/// Returns `None` if the call fails or the result is malformed.
#[cfg(target_os = "macos")]
fn frontmost_app() -> Option<(String, u32)> {
    let script = r#"
        tell application "System Events"
            try
                set p to first application process whose frontmost is true
                return (name of p) & "|" & (unix id of p)
            on error
                return ""
            end try
        end tell
    "#;
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut it = line.splitn(2, '|');
    let name = it.next()?.trim().to_string();
    let pid: u32 = it.next()?.trim().parse().ok()?;
    if name.is_empty() {
        return None;
    }
    Some((name, pid))
}

#[cfg(target_os = "macos")]
fn is_terminal_app(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    TERMINAL_APPS.iter().any(|t| n == t.to_ascii_lowercase())
}

/// Start the foreground-transition poller.
#[cfg(target_os = "macos")]
pub fn start_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if state.monitoring {
        return Ok(());
    }
    state.monitoring = true;
    drop(state);

    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let monitoring = DRAG_STATE.lock().map(|s| s.monitoring).unwrap_or(false);
        if !monitoring {
            break;
        }
        let Some((name, pid)) = frontmost_app() else {
            continue;
        };
        let is_termgrid = name.eq_ignore_ascii_case("TermGrid");
        let is_term = is_terminal_app(&name);
        if is_term {
            if let Ok(mut state) = DRAG_STATE.lock() {
                state.last_terminal_pid = Some(pid);
                state.last_terminal_at = Some(Instant::now());
            }
        } else if is_termgrid {
            // Snapshot the stashed terminal PID + age, drop the lock, then
            // do the (potentially slow) sysinfo walk to find the shell
            // child. Re-acquire the lock to publish the result.
            let term_pid = match DRAG_STATE.lock() {
                Ok(state) => {
                    let fresh = state
                        .last_terminal_at
                        .map(|t| t.elapsed().as_millis() < STALE_MS)
                        .unwrap_or(false);
                    if fresh {
                        state.last_terminal_pid
                    } else {
                        None
                    }
                }
                Err(_) => None,
            };
            if let Some(term_pid) = term_pid {
                let shell_pid =
                    super::discover::youngest_shell_descendant(term_pid).unwrap_or(term_pid);
                if let Ok(mut state) = DRAG_STATE.lock() {
                    state.pending_adoption_pid = Some(shell_pid);
                    state.last_terminal_pid = None;
                    state.last_terminal_at = None;
                }
            }
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
    state.last_terminal_pid = None;
    state.last_terminal_at = None;
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
pub fn start_drag_monitor() -> Result<(), String> {
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
