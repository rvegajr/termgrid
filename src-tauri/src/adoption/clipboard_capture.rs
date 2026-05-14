//! Opt-in clipboard-based "buffer scrape" for terminal hosts we have no
//! introspection path for (gnome-terminal, xterm, plain Wayland terms
//! that don't expose protocol-level introspection).
//!
//! The trick: most terminal emulators bind `Ctrl+Shift+A` to Select All
//! and `Ctrl+Shift+C` to Copy. So we:
//!   1. Save the current clipboard contents.
//!   2. Synthesize the Select-All + Copy keystrokes against the
//!      currently-focused window.
//!   3. Read the new clipboard.
//!   4. Restore the saved clipboard.
//!
//! This is **opt-in**, exposed via an explicit button in the picker
//! preview, never invoked automatically. Reasons:
//!  - It steals focus for the duration of the keypress (whatever window
//!    is foreground receives the key combo).
//!  - It briefly mutates the system clipboard — we restore, but the
//!    in-between state is observable.
//!  - It works only on X11 — Wayland's input/clipboard isolation makes
//!    `xdotool` and `xclip` non-functional there.
//!
//! Implementation lives only on Linux. macOS and Windows return an
//! explanatory `reason` so the UI can render a clear message.

use super::commands::ClipboardCapture;

/// Run the capture. Returns the captured text, or a non-empty `reason`
/// on every failure path. Never panics.
pub fn capture() -> ClipboardCapture {
    #[cfg(target_os = "linux")]
    {
        linux::capture()
    }
    #[cfg(not(target_os = "linux"))]
    {
        ClipboardCapture {
            text: None,
            reason: Some("clipboard scrape is Linux/X11 only".into()),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::ClipboardCapture;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    pub(super) fn capture() -> ClipboardCapture {
        // Wayland check: many distros set `XDG_SESSION_TYPE=wayland`.
        // Even on XWayland, xdotool's key synthesis is unreliable, so we
        // refuse cleanly here.
        if std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
        {
            return reason("clipboard scrape requires X11 (Wayland blocks key synthesis)");
        }
        if which("xclip").is_none() {
            return reason("xclip not found on PATH");
        }
        if which("xdotool").is_none() {
            return reason("xdotool not found on PATH");
        }

        // Step 1: save current clipboard.
        let saved = xclip_read().unwrap_or_default();

        // Step 2: synthesize Select-All + Copy on whatever window is
        // foreground. The user will have just focused the source
        // terminal — that's part of the workflow.
        if !xdotool_key("ctrl+shift+a") {
            return reason("xdotool key (select-all) failed");
        }
        // Give the host a moment to register the selection.
        thread::sleep(Duration::from_millis(80));
        if !xdotool_key("ctrl+shift+c") {
            return reason("xdotool key (copy) failed");
        }
        thread::sleep(Duration::from_millis(120));

        // Step 3: read the captured clipboard.
        let captured = xclip_read();

        // Step 4: restore the saved clipboard. Best-effort — failure here
        // logs but does not change the user-visible result.
        if !saved.is_empty() {
            let _ = xclip_write(&saved);
        }

        match captured {
            Some(t) if !t.is_empty() => ClipboardCapture {
                text: Some(t),
                reason: None,
            },
            _ => reason("nothing landed in clipboard — host may not support Ctrl+Shift+A/C"),
        }
    }

    fn reason(s: &str) -> ClipboardCapture {
        ClipboardCapture {
            text: None,
            reason: Some(s.to_string()),
        }
    }

    fn which(bin: &str) -> Option<String> {
        let out = Command::new("which").arg(bin).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }

    fn xclip_read() -> Option<String> {
        let out = Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn xclip_write(text: &str) -> bool {
        let Ok(mut child) = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        child.wait().map(|s| s.success()).unwrap_or(false)
    }

    fn xdotool_key(combo: &str) -> bool {
        Command::new("xdotool")
            .args(["key", "--clearmodifiers", combo])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
