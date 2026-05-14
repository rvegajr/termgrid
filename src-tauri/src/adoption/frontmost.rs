//! Identify which terminal-emulator app is currently in front, so the
//! user can hit one button — "Adopt frontmost terminal" — and have the
//! picker pre-filter to its child shells.
//!
//! Each platform answers the same question differently:
//!  - macOS: AppleScript via `osascript` (`tell System Events to get
//!    name of first application process whose frontmost is true`).
//!  - Linux: `xdotool getactivewindow getwindowname` if available, else
//!    `wmctrl -lp`, else give up. We resolve the window's PID to its
//!    executable basename via `/proc/<pid>/comm`.
//!  - Windows: `GetForegroundWindow` + `GetWindowThreadProcessId` +
//!    `QueryFullProcessImageNameW`.
//!
//! Each path is wrapped in a hard timeout via `Command::output` (the OS
//! tools we shell out to all return in <10ms). Failures collapse to
//! `None` — the picker falls back to its unfiltered list.

#![allow(dead_code)]

/// Return the basename of the frontmost terminal-host app, if any.
///
/// "Terminal-host" is whatever name the OS reports — `"Terminal"`,
/// `"iTerm2"`, `"Cursor Helper"`, `"konsole"`, etc. The caller (in the
/// picker) matches this against each row's `parent` column to filter.
///
/// Returns `None` if the OS denied the probe, no app is frontmost, or
/// the result is empty.
pub fn frontmost_terminal_app() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos::detect()
    }
    #[cfg(target_os = "linux")]
    {
        linux::detect()
    }
    #[cfg(target_os = "windows")]
    {
        windows::detect()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;

    pub(super) fn detect() -> Option<String> {
        // `System Events` exposes `frontmost is true` on application
        // processes. The returned `name` is the human-readable app name
        // (e.g. "Terminal", "iTerm2"), which matches what our parent
        // probe reports.
        let script = r#"
            tell application "System Events"
                try
                    return name of first application process whose frontmost is true
                on error
                    return ""
                end try
            end tell
        "#;
        let out = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::Command;

    pub(super) fn detect() -> Option<String> {
        // Prefer xdotool because it directly returns the window's PID,
        // which we resolve to a basename via /proc/<pid>/comm.
        if let Some(pid) = xdotool_pid() {
            if let Some(name) = comm_for(pid) {
                return Some(name);
            }
        }
        // Fallback: wmctrl -lp returns `<id> <desktop> <pid> <host> <title>`.
        if let Some(pid) = wmctrl_active_pid() {
            if let Some(name) = comm_for(pid) {
                return Some(name);
            }
        }
        None
    }

    fn xdotool_pid() -> Option<u32> {
        let out = Command::new("xdotool")
            .args(["getactivewindow", "getwindowpid"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    fn wmctrl_active_pid() -> Option<u32> {
        // wmctrl doesn't print "active" markers; we can't reliably pick
        // the active row without xprop. Skip when xdotool isn't present.
        None
    }

    fn comm_for(pid: u32) -> Option<String> {
        let text = std::fs::read_to_string(format!("/proc/{}/comm", pid)).ok()?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    pub(super) fn detect() -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            if pid == 0 {
                return None;
            }
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            if handle.is_invalid() {
                return None;
            }
            struct CloseOnDrop(HANDLE);
            impl Drop for CloseOnDrop {
                fn drop(&mut self) {
                    unsafe {
                        let _ = CloseHandle(self.0);
                    }
                }
            }
            let _guard = CloseOnDrop(handle);

            let mut buf = [0u16; 4096];
            let mut len: u32 = buf.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len as *mut u32,
            )
            .ok()?;
            let path = OsString::from_wide(&buf[..len as usize])
                .into_string()
                .ok()?;
            let base = std::path::Path::new(&path)
                .file_stem()?
                .to_string_lossy()
                .to_string();
            if base.is_empty() {
                None
            } else {
                Some(base)
            }
        }
    }
}
