//! Cross-platform "Adopt Session" — turn another terminal's running shell
//! into a TermGrid pane.
//!
//! Public surface:
//! - [`list_adoptable_sessions`] — enumerate every adoptable shell.
//! - [`snapshot_session`] — gather everything we need to spawn a continuation pane.
//!
//! Internally this dispatches to platform modules ([`macos`], [`linux`],
//! [`windows`]) for OS-specific bits like CWD probes; the cross-platform
//! enumeration logic lives in [`discover`].

pub mod buffer_scrape;
pub mod clipboard_capture;
pub mod commands;
pub mod discover;
pub mod env_capture;
pub mod frontmost;
pub mod history;
pub mod ssh_parse;
pub mod types;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

pub use types::{AdoptableSession, SessionSnapshot};

/// Read the CWD of an arbitrary process by PID. Best-effort.
///
/// Returns `None` if the OS denied the probe or the process exited. Never
/// errors — callers fall back to showing the session with a blank CWD.
pub(crate) fn cwd_of_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos::cwd_of_pid(pid)
    }
    #[cfg(target_os = "linux")]
    {
        linux::cwd_of_pid(pid)
    }
    #[cfg(target_os = "windows")]
    {
        windows::cwd_of_pid(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = pid;
        None
    }
}

/// Read the controlling TTY of an arbitrary process by PID. Best-effort.
pub(crate) fn tty_of_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos::tty_of_pid(pid)
    }
    #[cfg(target_os = "linux")]
    {
        linux::tty_of_pid(pid)
    }
    #[cfg(target_os = "windows")]
    {
        windows::tty_of_pid(pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = pid;
        None
    }
}

/// Enumerate every shell process the user might want to adopt.
///
/// Filters by `discover::SHELL_NAMES`, excludes processes descended from
/// TermGrid's own PID, and tags ssh-derived sessions for the picker.
pub fn list_adoptable_sessions() -> Vec<AdoptableSession> {
    discover::enumerate()
}

/// Build the full snapshot for a single session by PID.
///
/// Idempotent and side-effect free — safe to call multiple times. Returns
/// an empty snapshot (with the PID filled in) if the process exited before
/// we could read it.
pub fn snapshot_session(pid: u32) -> SessionSnapshot {
    discover::snapshot(pid)
}
