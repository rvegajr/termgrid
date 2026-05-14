//! **v5:** Linux X11 drag-from-OS-window adoption.
//!
//! Mirrors the Windows/macOS approach: we detect the foreground-window
//! transition (terminal → TermGrid) via `xdotool` and treat that as a
//! drag-to-drop proxy. True mouse-drag detection on X11 requires either
//! a global pointer hook (heavy) or AT-SPI integration (heavy + flaky on
//! many distros) — the foreground-switch proxy is what users actually
//! experience as "I picked it up and dropped it onto TermGrid".
//!
//! **Requirements:**
//! - X11 (Wayland not supported — no foreign-window introspection).
//! - `xdotool` on PATH (provides active-window PID lookup).
//!
//! Architecture:
//! 1. `start_drag_monitor()` — spawn poller thread (250 ms cadence).
//! 2. Poll `xdotool getactivewindow getwindowpid` → resolve name via
//!    `/proc/<pid>/comm`.
//! 3. On transition `terminal → TermGrid`, find youngest shell descendant
//!    of the previous terminal's PID, publish for the frontend poll.
//! 4. `stop_drag_monitor()` — stop the poller.

#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
lazy_static::lazy_static! {
    static ref DRAG_STATE: Arc<Mutex<DragState>> = Arc::new(Mutex::new(DragState::default()));
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct DragState {
    monitoring: bool,
    last_terminal_pid: Option<u32>,
    last_terminal_at: Option<Instant>,
    pending_adoption_pid: Option<u32>,
}

#[cfg(target_os = "linux")]
const TERMINAL_EXES: &[&str] = &[
    "gnome-terminal",
    "gnome-terminal-",
    "konsole",
    "xterm",
    "urxvt",
    "alacritty",
    "kitty",
    "terminator",
    "tilix",
    "wezterm-gui",
    "wezterm",
    "ghostty",
];

#[cfg(target_os = "linux")]
const STALE_MS: u128 = 5_000;

#[cfg(target_os = "linux")]
fn is_terminal_exe(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    TERMINAL_EXES.iter().any(|t| n == *t)
}

/// Return `(comm, pid)` of the X11 active window, via `xdotool`.
#[cfg(target_os = "linux")]
fn active_window() -> Option<(String, u32)> {
    let out = std::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowpid"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    let comm = std::fs::read_to_string(format!("/proc/{}/comm", pid)).ok()?;
    let comm = comm.trim().to_string();
    if comm.is_empty() {
        return None;
    }
    Some((comm, pid))
}

/// Start monitoring for drag-to-drop events.
#[cfg(target_os = "linux")]
pub fn start_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if state.monitoring {
        return Ok(());
    }
    if std::env::var("WAYLAND_DISPLAY").is_ok()
        && std::env::var("DISPLAY")
            .ok()
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return Err(
            "Drag monitoring requires X11. Wayland does not support foreign-window introspection."
                .into(),
        );
    }
    state.monitoring = true;
    drop(state);

    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let monitoring = DRAG_STATE.lock().map(|s| s.monitoring).unwrap_or(false);
        if !monitoring {
            break;
        }
        let Some((comm, pid)) = active_window() else {
            continue;
        };
        let is_termgrid =
            comm.eq_ignore_ascii_case("termgrid") || comm.eq_ignore_ascii_case("TermGrid");
        let is_term = is_terminal_exe(&comm);
        if is_term {
            if let Ok(mut state) = DRAG_STATE.lock() {
                state.last_terminal_pid = Some(pid);
                state.last_terminal_at = Some(Instant::now());
            }
        } else if is_termgrid {
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
#[cfg(target_os = "linux")]
pub fn stop_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    state.monitoring = false;
    state.pending_adoption_pid = None;
    state.last_terminal_pid = None;
    state.last_terminal_at = None;
    Ok(())
}

/// Poll for pending drag-to-drop adoption PIDs.
#[cfg(target_os = "linux")]
pub fn poll_drag_events() -> Option<u32> {
    let mut state = DRAG_STATE.lock().ok()?;
    state.pending_adoption_pid.take()
}

// Stubs for non-Linux builds
#[cfg(not(target_os = "linux"))]
pub fn start_drag_monitor() -> Result<(), String> {
    Err("Drag monitoring requires X11 (not available on Wayland or non-Linux)".into())
}

#[cfg(not(target_os = "linux"))]
pub fn stop_drag_monitor() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn poll_drag_events() -> Option<u32> {
    None
}
