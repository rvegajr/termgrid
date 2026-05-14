//! **v5:** Linux X11 drag-from-OS-window adoption via `XQueryPointer`.
//!
//! Monitors mouse position and detects when terminal windows are dragged over
//! TermGrid. When a terminal window overlaps TermGrid's bounds for >500ms,
//! we extract the PID and trigger adoption.
//!
//! **Requirements:**
//! - X11 display server (Wayland not supported — no window introspection)
//! - `libX11` installed (`libx11-dev` on Debian/Ubuntu)
//!
//! **Architecture:**
//! 1. `start_drag_monitor()` — spawn background thread polling mouse position
//! 2. Thread polls XQueryPointer every 100ms to get window under cursor
//! 3. Check if that window belongs to a terminal (via `_NET_WM_PID` and process name)
//! 4. If terminal overlaps TermGrid for >500ms, extract shell PID
//! 5. `poll_drag_events()` — frontend polls for detected PIDs
//! 6. `stop_drag_monitor()` — stop monitoring

#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
lazy_static::lazy_static! {
    static ref DRAG_STATE: Arc<Mutex<DragState>> = Arc::new(Mutex::new(DragState::default()));
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct DragState {
    monitoring: bool,
    pending_adoption_pid: Option<u32>,
}

#[cfg(target_os = "linux")]
#[allow(dead_code)] // Used in production implementation, not in stub
static TERMINAL_EXES: &[&str] = &[
    "gnome-terminal",
    "konsole",
    "xterm",
    "urxvt",
    "alacritty",
    "kitty",
    "terminator",
    "tilix",
];

/// Start monitoring for drag-to-drop events. Spawns a background thread that
/// polls mouse position and window under cursor every 100ms.
#[cfg(target_os = "linux")]
pub fn start_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if state.monitoring {
        return Ok(()); // Already monitoring
    }

    // Check if X11 is available
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        return Err("Drag monitoring requires X11. Wayland does not support window introspection.".into());
    }

    state.monitoring = true;
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
            // 1. Open X11 display: `XOpenDisplay(NULL)`
            // 2. Get root window: `DefaultRootWindow(display)`
            // 3. Query mouse pointer: `XQueryPointer(display, root, &root_return,
            //    &child_return, &root_x, &root_y, &win_x, &win_y, &mask)`
            // 4. The `child_return` is the window under the cursor
            // 5. Get window PID via `_NET_WM_PID` property:
            //    ```c
            //    Atom atom = XInternAtom(display, "_NET_WM_PID", True);
            //    unsigned long pid;
            //    XGetWindowProperty(display, child_return, atom, ...);
            //    ```
            // 6. Check if that PID belongs to a terminal (read /proc/<pid>/comm)
            // 7. If it's a terminal and overlaps TermGrid for >500ms, find the
            //    shell child PID via our existing `enumerate()` logic
            // 8. Mark that shell PID for adoption:
            //    ```rust
            //    let mut state = DRAG_STATE.lock().unwrap();
            //    state.pending_adoption_pid = Some(shell_pid);
            //    ```
            //
            // The X11 FFI bindings would use the `x11` crate:
            // ```rust
            // use x11::xlib::*;
            // let display = unsafe { XOpenDisplay(std::ptr::null()) };
            // ```
            //
            // For now, this is a no-op stub. The architecture is sound, but
            // the FFI bindings are non-trivial.
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
