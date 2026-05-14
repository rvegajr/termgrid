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
pub mod drag_linux;
pub mod drag_macos;
pub mod drag_windows;
pub mod env_capture;
pub mod env_macos_native;
pub mod frontmost;
pub mod history;
pub mod plugin_installer;
pub mod shell_plugin;
pub mod ssh_parse;
pub mod types;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub use types::{AdoptableSession, SessionSnapshot, SshTarget};

/// Walk the descendants of `root_pid` and return the parsed ssh/mosh target
/// of the first ssh-family process found, if any. Used by the per-pane
/// "where am I" badge: given a pane's shell PID, detect when the user has
/// SSHed into a remote host.
///
/// Cheap (one sysinfo refresh + one `ps -o args=` on a hit). Returns `None`
/// when no ssh descendant exists or argv parsing fails.
pub fn find_ssh_descendant(root_pid: u32) -> Option<SshTarget> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    // Walk children via the System directly to avoid exposing discover internals.
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let mut names: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        let pid_u32 = pid.as_u32();
        names.insert(pid_u32, proc.name().to_string_lossy().into_owned());
        if let Some(ppid) = proc.parent() {
            children.entry(ppid.as_u32()).or_default().push(pid_u32);
        }
    }
    let mut stack = vec![root_pid];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if pid != root_pid {
            if let Some(name) = names.get(&pid) {
                let low = name.to_ascii_lowercase();
                if low == "ssh" || low == "mosh" || low == "mosh-client" {
                    if let Some(target) = ssh_parse::parse_ssh_for_pid(pid) {
                        return Some(target);
                    }
                }
            }
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    None
}

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
