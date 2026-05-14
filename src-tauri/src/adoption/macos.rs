//! macOS-specific CWD/TTY probes for session adoption.
//!
//! We shell out to `lsof` and `ps` rather than calling private APIs or
//! requiring `libproc`'s lower-level surface. The picker enumerates ~20
//! candidate shells in the worst case; a few-ms shell-out per PID is
//! well within the user's tolerance and avoids new ffi dependencies.
//!
//! Both `lsof` and `ps` are shipped with the OS in `/usr/sbin` and `/bin`
//! respectively, so they're always available. Errors are swallowed — the
//! picker just displays a blank cell when a probe fails.

use std::process::Command;

/// Read the current working directory of an arbitrary PID.
///
/// Uses `lsof -p <pid> -a -d cwd -Fn`, which prints lines prefixed with
/// `n` for the CWD path. Returns `None` on lookup failure or empty path.
pub(super) fn cwd_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-p", &pid.to_string(), "-a", "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix('n') {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Read the controlling TTY of an arbitrary PID.
///
/// `ps -p <pid> -o tty=` returns short names like `ttys003`. We re-prefix
/// with `/dev/` so the value is directly user-meaningful.
pub(super) fn tty_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "tty="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed == "??" || trimmed == "?" {
        return None;
    }
    Some(format!("/dev/{}", trimmed))
}
