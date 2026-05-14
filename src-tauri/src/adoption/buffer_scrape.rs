//! Best-effort visible-terminal-buffer capture.
//!
//! v1 captured CWD, history, and env-shaped metadata; v2 adds the most
//! requested missing piece — what the user actually *sees* on screen in
//! the source terminal — and pipes it into the adopted pane as a context
//! preview.
//!
//! This module is intentionally permissive about failure modes. The
//! AppleScript bridges below run unsigned, depend on the user having
//! granted Automation permission to TermGrid for the target app, and may
//! return empty strings, locked-window errors, or hang. We swallow every
//! failure to `None` and let the picker fall back to v1 metadata-only
//! adoption.
//!
//! Non-macOS platforms always return `None`. Linux/Windows buffer scrape
//! requires Accessibility / UI Automation work that's deferred to v3.

#![allow(dead_code)]

/// Cap on bytes returned to the frontend.
///
/// 16 KiB is roughly 200 lines of a typical 80-col terminal, which is
/// enough context for a preview without blowing up the picker JSON.
const MAX_PREVIEW_BYTES: usize = 16 * 1024;

/// Top-level entry point: try to scrape the visible buffer for `pid`.
///
/// Dispatch order (first non-`None` wins):
/// 1. **tmux** — if the candidate's parent (or transitive ancestor) is a
///    tmux server, ask tmux directly via `tmux capture-pane -p`. Works
///    on every OS, requires no permission prompts, and returns the
///    correct pane every time. This is the highest-fidelity scrape we
///    can do anywhere.
/// 2. **macOS host apps** — Terminal.app + iTerm2 via AppleScript with
///    per-tty matching.
/// 3. **Linux konsole** — qdbus call to `org.kde.konsole`.
/// 4. Everything else returns `None`.
///
/// We don't probe blindly because each AppleScript "tell" otherwise
/// produces a permission prompt for an app the user isn't even using.
///
/// `parent` is the terminal-host name from `discover::classify_ancestry`.
///
/// **v3:** when `tty` is provided (e.g. `/dev/ttys038`), we enumerate every
/// tab/session in the host app and scrape *exactly* the one bound to that
/// TTY. This replaces v2's frontmost-tab heuristic for the common case
/// where the user has many tabs open in Terminal.app — the picker no
/// longer surfaces the wrong tab's buffer.
pub fn scrape(pid: u32, parent: Option<&str>, tty: Option<&str>) -> Option<String> {
    // Universal path: tmux. Cross-platform, no permissions, exact match.
    if let Some(buf) = tmux::scrape(pid, tty) {
        return Some(trim_preview(&buf));
    }

    #[cfg(target_os = "macos")]
    {
        let host = parent?;
        let raw = match host {
            "Terminal" => macos::scrape_terminal_app(pid, tty),
            "iTerm2" | "iTerm" => macos::scrape_iterm2(pid, tty),
            _ => None,
        };
        raw.map(|s| trim_preview(&s))
    }

    #[cfg(target_os = "linux")]
    {
        let host = parent?;
        if host.eq_ignore_ascii_case("konsole") {
            if let Some(buf) = konsole::scrape() {
                return Some(trim_preview(&buf));
            }
        }
        let _ = pid;
        let _ = tty;
        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (pid, parent, tty);
        None
    }
}

/// Trim a scraped buffer to the size cap.
///
/// We trim *from the start* so the user always sees the latest content
/// (most relevant for "what was just on screen") and append an ellipsis
/// marker if truncation happened.
fn trim_preview(s: &str) -> String {
    // Normalize Windows-style line endings; AppleScript can emit either.
    let normalized = s.replace("\r\n", "\n");
    // Strip leading blank lines so the preview starts at first content.
    let trimmed = normalized.trim_start_matches('\n');
    if trimmed.len() <= MAX_PREVIEW_BYTES {
        return trimmed.to_string();
    }
    // Find a UTF-8 char boundary at or after the cutoff so we don't
    // slice a multi-byte sequence in half.
    let cutoff = trimmed.len() - MAX_PREVIEW_BYTES;
    let mut start = cutoff;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    let tail = &trimmed[start..];
    // Step forward to the next newline so the preview starts on a clean
    // line rather than mid-word.
    let line_start = tail.find('\n').map(|i| i + 1).unwrap_or(0);
    format!("…\n{}", &tail[line_start..])
}

/// tmux scrape — works on every host with a tmux client/server.
///
/// Strategy: ask tmux to list every pane with its tty + target spec
/// (`session:window.pane`), match against the candidate's tty, then call
/// `tmux capture-pane -p -t <target>` to dump that pane's visible
/// buffer. If the candidate isn't in tmux at all we return `None`
/// instantly (one cheap `tmux list-panes` call).
mod tmux {
    use std::process::Command;

    /// Try to scrape the visible buffer for `pid`.
    ///
    /// Returns `None` if tmux isn't running, the candidate isn't inside
    /// a tmux pane, or `tmux` isn't on `PATH`. Never errors.
    pub(super) fn scrape(pid: u32, tty: Option<&str>) -> Option<String> {
        // We need the candidate's TTY to match a tmux pane. tmux's
        // per-pane `pane_tty` is the pseudoterminal the pane wraps —
        // matches the same `/dev/ttys???` paths we get from `ps`.
        let target_tty = tty?;
        let panes = list_panes()?;
        let target = panes.into_iter().find_map(|p| {
            if p.tty == target_tty {
                Some(p.target)
            } else {
                None
            }
        })?;
        // -p: print to stdout; -J: join wrapped lines so we see flowed
        // output the way the user saw it; -S -2000: 2000 lines of
        // scrollback above the visible region. trim_preview caps the
        // total bytes.
        let out = Command::new("tmux")
            .args(["capture-pane", "-p", "-J", "-S", "-2000", "-t", &target])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).into_owned();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        let _ = pid;
        Some(trimmed.to_string())
    }

    struct Pane {
        tty: String,
        target: String,
    }

    /// `tmux list-panes -a -F '#{pane_tty}|#{session_name}:#{window_index}.#{pane_index}'`
    /// across every session. Returns `None` if tmux isn't running.
    fn list_panes() -> Option<Vec<Pane>> {
        let out = Command::new("tmux")
            .args([
                "list-panes",
                "-a",
                "-F",
                "#{pane_tty}|#{session_name}:#{window_index}.#{pane_index}",
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut out_v = Vec::new();
        for line in text.lines() {
            if let Some((tty, target)) = line.split_once('|') {
                if !tty.is_empty() && !target.is_empty() {
                    out_v.push(Pane {
                        tty: tty.to_string(),
                        target: target.to_string(),
                    });
                }
            }
        }
        Some(out_v)
    }
}

/// konsole scrape via qdbus (KDE).
///
/// konsole exposes per-window/per-session methods over D-Bus:
///   `qdbus org.kde.konsole-<pid> /Sessions/<id> org.kde.konsole.Session.text`
/// We don't enumerate every konsole window — we ask `qdbus` to list
/// services, find one matching `org.kde.konsole`, list its sessions,
/// and request `text` from the first. This is best-effort; users with
/// multiple konsole windows may need to bring the right one to front.
///
/// Skipped entirely if `qdbus` isn't available.
#[cfg(target_os = "linux")]
mod konsole {
    use std::process::Command;

    pub(super) fn scrape() -> Option<String> {
        // Find a konsole service.
        let services = Command::new("qdbus").output().ok()?;
        if !services.status.success() {
            return None;
        }
        let service = String::from_utf8_lossy(&services.stdout)
            .lines()
            .find(|l| l.starts_with("org.kde.konsole-"))?
            .to_string();

        // Enumerate sessions on that service.
        let sessions = Command::new("qdbus")
            .args([&service, "/Sessions"])
            .output()
            .ok()?;
        let sess_path = String::from_utf8_lossy(&sessions.stdout)
            .lines()
            .find(|l| l.starts_with("/Sessions/"))?
            .to_string();

        // Pull the text.
        let text = Command::new("qdbus")
            .args([&service, &sess_path, "org.kde.konsole.Session.text"])
            .output()
            .ok()?;
        if !text.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&text.stdout).into_owned();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;
    use std::time::Duration;

    /// Hard timeout on each AppleScript invocation.
    ///
    /// Real-world `osascript` calls against a healthy target return in
    /// ~30ms. We give them 1500ms grace and kill anything longer rather
    /// than freezing the picker on a permission prompt or busy app.
    const SCRIPT_TIMEOUT: Duration = Duration::from_millis(1500);

    /// Escape a value for embedding inside an AppleScript double-quoted
    /// string literal.
    ///
    /// AppleScript treats `\` and `"` specially inside double-quoted
    /// strings; everything else passes through. We escape both. TTY paths
    /// are well-formed `/dev/ttys???` shapes in practice so this is
    /// belt-and-suspenders, but the function is correct for arbitrary
    /// input (we pass it back through into a `format!`-built script).
    pub(super) fn escape_for_applescript(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 4);
        for ch in s.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                _ => out.push(ch),
            }
        }
        out
    }

    pub(super) fn scrape_terminal_app(pid: u32, tty: Option<&str>) -> Option<String> {
        // v3 path: if we know the candidate's TTY, walk every window/tab
        // and match. Terminal.app exposes a `tty` property per tab as a
        // path like "/dev/ttys038".
        if let Some(t) = tty {
            let escaped = escape_for_applescript(t);
            let script = format!(
                r#"
                tell application "Terminal"
                    if (count of windows) is 0 then return ""
                    set targetTty to "{escaped}"
                    repeat with w in windows
                        repeat with tb in tabs of w
                            try
                                if (tty of tb) is targetTty then
                                    try
                                        return (history of tb) as text
                                    on error
                                        return (contents of tb) as text
                                    end try
                                end if
                            end try
                        end repeat
                    end repeat
                    return ""
                end tell
                "#
            );
            if let Some(buf) = run_osascript(&script) {
                return Some(buf);
            }
            // Fall through to frontmost-tab fallback if the tty match
            // returned empty (e.g. the user closed the tab in between).
        }

        // Fallback: frontmost tab. Matches v2 behavior.
        let script = r#"
            tell application "Terminal"
                if (count of windows) is 0 then return ""
                set t to selected tab of front window
                try
                    return (history of t) as text
                on error
                    try
                        return (contents of t) as text
                    on error
                        return ""
                    end try
                end try
            end tell
        "#;
        let _ = pid;
        run_osascript(script)
    }

    pub(super) fn scrape_iterm2(pid: u32, tty: Option<&str>) -> Option<String> {
        // v3 path: enumerate every session across every window and match
        // by tty. iTerm2's sessions expose a `tty` property identically
        // to Terminal.app tabs.
        if let Some(t) = tty {
            let escaped = escape_for_applescript(t);
            let script = format!(
                r#"
                tell application "iTerm2"
                    if (count of windows) is 0 then return ""
                    set targetTty to "{escaped}"
                    repeat with w in windows
                        repeat with t in tabs of w
                            repeat with s in sessions of t
                                try
                                    if (tty of s) is targetTty then
                                        return (contents of s) as text
                                    end if
                                end try
                            end repeat
                        end repeat
                    end repeat
                    return ""
                end tell
                "#
            );
            if let Some(buf) = run_osascript(&script) {
                return Some(buf);
            }
            // Fall through to current-session fallback.
        }

        let script = r#"
            tell application "iTerm2"
                if (count of windows) is 0 then return ""
                try
                    return (contents of current session of current window) as text
                on error
                    return ""
                end try
            end tell
        "#;
        let _ = pid;
        run_osascript(script)
    }

    /// Run an AppleScript with a hard timeout. Returns `None` on any
    /// failure mode (non-zero exit, timeout, empty result, decode error).
    fn run_osascript(script: &str) -> Option<String> {
        // `Command::output` doesn't support timeouts directly, so we
        // spawn + wait_timeout via a dedicated thread. For our 1.5s
        // budget that's acceptable overhead.
        let mut child = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .ok()?;

        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    let out = child.wait_with_output().ok()?;
                    let s = String::from_utf8_lossy(&out.stdout).into_owned();
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        return None;
                    }
                    return Some(trimmed.to_string());
                }
                Ok(None) => {
                    if start.elapsed() > SCRIPT_TIMEOUT {
                        let _ = child.kill();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_preview_passes_through_short_input() {
        let s = "hello\nworld\n";
        assert_eq!(trim_preview(s), "hello\nworld\n");
    }

    #[test]
    fn trim_preview_normalizes_crlf() {
        let s = "a\r\nb\r\nc\r\n";
        assert_eq!(trim_preview(s), "a\nb\nc\n");
    }

    #[test]
    fn trim_preview_strips_leading_blank_lines() {
        let s = "\n\n\nfirst\nsecond\n";
        assert_eq!(trim_preview(s), "first\nsecond\n");
    }

    #[test]
    fn trim_preview_caps_long_input_with_ellipsis() {
        // Build something well over the cap by repeating a line.
        let line = "x".repeat(80);
        let big = (0..1000)
            .map(|_| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let out = trim_preview(&big);
        assert!(out.starts_with("…\n"), "expected ellipsis prefix");
        assert!(out.len() <= MAX_PREVIEW_BYTES + 8); // +8 for "…\n" + slack
    }

    #[test]
    fn trim_preview_respects_utf8_boundaries() {
        // Repeat a multi-byte char to force the cutoff into the middle of one.
        let s = "héllo\n".repeat(5000);
        let out = trim_preview(&s);
        // Just verify we produced valid UTF-8 and didn't panic.
        assert!(out.is_char_boundary(0));
        assert!(out.is_char_boundary(out.len()));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn scrape_returns_none_on_non_macos() {
        assert_eq!(scrape(1234, Some("Terminal"), Some("/dev/ttys003")), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn escape_for_applescript_passes_through_plain_strings() {
        let out = super::macos::escape_for_applescript("/dev/ttys038");
        assert_eq!(out, "/dev/ttys038");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn escape_for_applescript_escapes_quotes_and_backslashes() {
        let out = super::macos::escape_for_applescript(r#"a"b\c"#);
        assert_eq!(out, r#"a\"b\\c"#);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn escape_for_applescript_handles_empty_input() {
        assert_eq!(super::macos::escape_for_applescript(""), "");
    }
}
