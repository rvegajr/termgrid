//! Linux-specific CWD/TTY probes for session adoption.
//!
//! `/proc` is the entire API. No new dependencies, no shell-outs.

use std::fs;
use std::path::PathBuf;

/// CWD via `readlink /proc/<pid>/cwd`. Returns `None` if the link is
/// missing or unreadable (process exited, permission denied on a hardened
/// kernel, etc).
pub(super) fn cwd_of_pid(pid: u32) -> Option<String> {
    let path = PathBuf::from(format!("/proc/{}/cwd", pid));
    fs::read_link(path)
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
}

/// Controlling TTY via `readlink /proc/<pid>/fd/0`. This is a heuristic —
/// fd 0 is usually the TTY for an interactive shell — and may point
/// elsewhere if the shell was launched with redirected stdin.
pub(super) fn tty_of_pid(pid: u32) -> Option<String> {
    let path = PathBuf::from(format!("/proc/{}/fd/0", pid));
    let target = fs::read_link(path).ok()?;
    let s = target.into_os_string().into_string().ok()?;
    if s.starts_with("/dev/") {
        Some(s)
    } else {
        None
    }
}
