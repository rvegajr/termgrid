//! **v5:** Windows drag-from-OS-window adoption via `SetWinEventHook`.
//!
//! Implements true drag-to-pane on Windows by monitoring foreground window
//! changes and detecting terminal windows. When the user drags a terminal
//! window over TermGrid and releases, we extract the shell PID and trigger
//! adoption.
//!
//! **Architecture:**
//! 1. Start monitoring with `start_drag_monitor()` — installs a Win event hook
//! 2. Hook fires on `EVENT_SYSTEM_FOREGROUND` — we check if it's a terminal
//! 3. Frontend polls `poll_drag_events()` to get PID when drag completes
//! 4. Stop monitoring with `stop_drag_monitor()`
//!
//! **Limitations:**
//! - This is a "fake drag" detector — we can't truly detect mouse drag ops
//!   from foreign windows without injecting into them. Instead, we detect
//!   rapid focus changes (terminal → TermGrid) as a proxy for drag intent.
//! - Works best when user Alt+Tabs or clicks between windows.
//! - True drag detection would require a global mouse hook, which is heavy.

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    System::{
        Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetWinEventHook, UnhookWinEvent,
        EVENT_SYSTEM_FOREGROUND, HWINEVENTHOOK, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    },
};

#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
lazy_static::lazy_static! {
    static ref DRAG_STATE: Arc<Mutex<DragState>> = Arc::new(Mutex::new(DragState::default()));
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct DragState {
    hook: Option<HWINEVENTHOOK>,
    last_terminal_pid: Option<u32>,
    pending_adoption_pid: Option<u32>,
}

#[cfg(target_os = "windows")]
static TERMINAL_EXES: &[&str] = &[
    "WindowsTerminal.exe",
    "wt.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "ConHost.exe",
];

#[cfg(target_os = "windows")]
unsafe extern "system" fn win_event_callback(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    // Called on EVENT_SYSTEM_FOREGROUND. If the new foreground window
    // belongs to a terminal process, remember its PID. If it's TermGrid,
    // and we just saw a terminal, mark it as a pending adoption.

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    if pid == 0 {
        return;
    }

    let exe_name = match query_process_name(pid) {
        Some(n) => n,
        None => return,
    };

    let is_terminal = TERMINAL_EXES.iter().any(|t| exe_name.eq_ignore_ascii_case(t));
    let is_termgrid = exe_name.eq_ignore_ascii_case("TermGrid.exe");

    let mut state = match DRAG_STATE.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    if is_terminal {
        state.last_terminal_pid = Some(pid);
    } else if is_termgrid {
        // If we just saw a terminal and now TermGrid is foreground, treat
        // it as a "drag-to-drop" proxy.
        if let Some(term_pid) = state.last_terminal_pid {
            state.pending_adoption_pid = Some(term_pid);
            state.last_terminal_pid = None;
        }
    } else {
        // Some other app is foreground; reset tracking
        state.last_terminal_pid = None;
    }
}

#[cfg(target_os = "windows")]
fn query_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 260];
        let mut size = buffer.len() as u32;
        QueryFullProcessImageNameW(handle, 0, &mut buffer, &mut size).ok()?;
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        path.split('\\').last().map(|s| s.to_string())
    }
}

/// Start monitoring for drag-to-drop events. Installs a Windows event hook
/// that tracks foreground window changes.
#[cfg(target_os = "windows")]
pub fn start_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if state.hook.is_some() {
        return Ok(()); // Already monitoring
    }

    unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(win_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.is_invalid() {
            return Err("Failed to install Windows event hook".into());
        }
        state.hook = Some(hook);
    }
    Ok(())
}

/// Stop monitoring for drag events.
#[cfg(target_os = "windows")]
pub fn stop_drag_monitor() -> Result<(), String> {
    let mut state = DRAG_STATE.lock().map_err(|e| e.to_string())?;
    if let Some(hook) = state.hook.take() {
        unsafe {
            UnhookWinEvent(hook);
        }
    }
    state.last_terminal_pid = None;
    state.pending_adoption_pid = None;
    Ok(())
}

/// Poll for pending drag-to-drop adoption PIDs. Returns `Some(pid)` if
/// a terminal window was dragged to TermGrid since the last poll.
#[cfg(target_os = "windows")]
pub fn poll_drag_events() -> Option<u32> {
    let mut state = DRAG_STATE.lock().ok()?;
    state.pending_adoption_pid.take()
}

// Stubs for non-Windows platforms
#[cfg(not(target_os = "windows"))]
pub fn start_drag_monitor() -> Result<(), String> {
    Err("Drag monitoring is only supported on Windows".into())
}

#[cfg(not(target_os = "windows"))]
pub fn stop_drag_monitor() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn poll_drag_events() -> Option<u32> {
    None
}
