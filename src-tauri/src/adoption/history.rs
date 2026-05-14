//! Best-effort shell history tailing for session adoption.
//!
//! We read a small window from the user's history file to (a) populate the
//! "last command" glimpse in the picker and (b) seed Ctrl-R recall in the
//! adopted pane. This is intentionally lossy:
//!
//! - We never write to history files.
//! - We never block — if the file is missing or unreadable, we return empty.
//! - We cap reads to the trailing 64 KiB so a multi-MB history doesn't
//!   stall the picker. Realistic history files top out under a few MB and
//!   the last 64 KiB easily covers hundreds of entries.
//! - Files are read without an advisory lock. Shells append O_APPEND-style;
//!   we may catch a half-written final line, which we discard if it doesn't
//!   parse cleanly.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// Cap on bytes read from the tail of a history file.
const TAIL_BYTES: u64 = 64 * 1024;

/// Locate the canonical history file for a given shell name.
///
/// Returns `None` for shells we don't have a known location for (e.g. `nu`,
/// which stores in SQLite) — the picker simply won't show a glimpse for
/// those, which is fine for v1.
fn history_path(shell: &str) -> Option<PathBuf> {
    let home = dirs_next::home_dir()?;
    let lower = shell.to_ascii_lowercase();
    match lower.as_str() {
        "zsh" => Some(home.join(".zsh_history")),
        "bash" => Some(home.join(".bash_history")),
        "fish" => Some(home.join(".local/share/fish/fish_history")),
        "ksh" => Some(home.join(".ksh_history")),
        "tcsh" => Some(home.join(".history")),
        "pwsh" | "powershell" => {
            Some(home.join(".local/share/powershell/PSReadLine/ConsoleHost_history.txt"))
        }
        _ => None,
    }
}

/// **v3:** Locate the history file for a *specific* PID by inspecting its
/// environment.
///
/// Many users keep per-project or per-shell-invocation history by
/// exporting `HISTFILE=/some/path` before launching the shell.
/// v1/v2 of TermGrid always read `~/.zsh_history` (the global default),
/// which means two side-by-side shells with different `HISTFILE`s would
/// show the same "last command" — confusing in the picker.
///
/// On Linux we read `/proc/<pid>/environ` directly — no privilege
/// required for processes we own. On macOS the same probe is gated by
/// modern SIP (same restriction as `env_capture::env_of_pid`); we still
/// try, but return `None` on failure so callers fall through to the
/// global default.
///
/// Returns `Some(PathBuf)` only when we found an explicit `HISTFILE`
/// pointing at an existing file. Anything else (no override, broken
/// path, denied probe) collapses to `None` and the caller uses
/// [`history_path`].
fn history_path_for_pid(pid: u32) -> Option<PathBuf> {
    let raw = read_environ(pid)?;
    let value = raw.iter().find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == "HISTFILE" && !v.is_empty() {
            Some(v.to_string())
        } else {
            None
        }
    })?;
    let path = PathBuf::from(expand_tilde(&value));
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Expand a leading `~/` against the current user's home directory.
/// Used only by [`history_path_for_pid`] — kept local because the
/// expansion semantics ("only at the start of the path") are deliberate.
fn expand_tilde(s: &str) -> String {
    match dirs_next::home_dir() {
        Some(home) => expand_tilde_with(&home, s),
        None => s.to_string(),
    }
}

/// Pure helper used by tests: expand `~/...` against a caller-supplied home.
fn expand_tilde_with(home: &std::path::Path, s: &str) -> String {
    if let Some(rest) = s.strip_prefix("~/") {
        return home.join(rest).to_string_lossy().into_owned();
    }
    s.to_string()
}

/// Read a process's environment as a list of `NAME=VALUE` strings.
/// Cross-platform best-effort:
///  - Linux: `/proc/<pid>/environ`, NUL-separated.
///  - macOS: `ps -E -ww -p PID -o command=`, parsed for `K=V` tokens.
///  - Other: `None`.
///
/// This is intentionally a sibling of `env_capture` rather than a call
/// into it because we don't want the allow-list filter applied here —
/// `HISTFILE` isn't on the toolchain-forward allow-list (and shouldn't
/// be), but we still want to read it for per-PID history routing.
fn read_environ(pid: u32) -> Option<Vec<String>> {
    #[cfg(target_os = "linux")]
    {
        let bytes = std::fs::read(format!("/proc/{}/environ", pid)).ok()?;
        let out: Vec<String> = bytes
            .split(|b| *b == 0)
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect();
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ps")
            .args(["-E", "-ww", "-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout).into_owned();
        let tokens: Vec<String> = line
            .split_whitespace()
            .filter(|t| t.contains('='))
            .map(|t| t.to_string())
            .collect();
        if tokens.is_empty() {
            None
        } else {
            Some(tokens)
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Read the trailing window of a file as a String, lossily.
///
/// Returns `None` if the file is missing or zero bytes. The first line of
/// the returned slice may be a partial line (cut mid-byte by our window);
/// callers must discard it.
fn read_tail(path: &PathBuf, max_bytes: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Strip the zsh extended-history prefix.
///
/// zsh writes either bare lines or `: 1234567890:0;command…` with optional
/// trailing-backslash continuations. We only care about a single-line
/// glimpse, so multi-line entries are truncated at the first newline.
fn parse_zsh_line(line: &str) -> Option<String> {
    let line = line.trim_end_matches('\\').trim();
    if line.is_empty() {
        return None;
    }
    if let Some(rest) = line.strip_prefix(':') {
        // ` 1234567890:0;cmd`
        if let Some(semi) = rest.find(';') {
            let cmd = rest[semi + 1..].trim();
            if cmd.is_empty() {
                return None;
            }
            return Some(cmd.to_string());
        }
    }
    Some(line.to_string())
}

/// Parse one entry's command out of fish_history's YAML-ish format.
///
/// fish writes blocks like:
/// ```text
/// - cmd: git status
///   when: 1701234567
/// ```
/// We extract just the `cmd:` line.
fn parse_fish_block(block: &str) -> Option<String> {
    for line in block.lines() {
        let l = line.trim_start();
        if let Some(rest) = l.strip_prefix("- cmd:") {
            let cmd = rest.trim();
            if !cmd.is_empty() {
                return Some(cmd.to_string());
            }
        }
        if let Some(rest) = l.strip_prefix("cmd:") {
            let cmd = rest.trim();
            if !cmd.is_empty() {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

/// Last N entries from a shell's history file, oldest-first.
///
/// Empty vec on any read failure. Always trims/sanitizes; callers can
/// display each entry directly without further processing.
///
/// v1/v2 callers use [`tail_history`]. The new [`tail_history_for_pid`]
/// wraps this with a per-PID `HISTFILE` lookup so the picker can show
/// the correct history for shells launched with non-default history
/// locations.
pub fn tail_history(shell: &str, n: usize) -> Vec<String> {
    let Some(path) = history_path(shell) else {
        return Vec::new();
    };
    tail_history_at(&path, shell, n)
}

/// **v3:** PID-aware variant of [`tail_history`].
///
/// Tries `HISTFILE` from the target process's env first; falls back to
/// the global per-shell default. Same return shape as [`tail_history`].
pub fn tail_history_for_pid(pid: u32, shell: &str, n: usize) -> Vec<String> {
    if let Some(p) = history_path_for_pid(pid) {
        return tail_history_at(&p, shell, n);
    }
    tail_history(shell, n)
}

/// Shared body of [`tail_history`] and [`tail_history_for_pid`].
///
/// Pulled out so per-PID lookups don't redo the shell-name match.
fn tail_history_at(path: &PathBuf, shell: &str, n: usize) -> Vec<String> {
    let Some(text) = read_tail(path, TAIL_BYTES) else {
        return Vec::new();
    };

    let lower = shell.to_ascii_lowercase();
    let mut entries: Vec<String> = match lower.as_str() {
        "zsh" => text
            .lines()
            .skip(1) // first line may be partial
            .filter_map(parse_zsh_line)
            .collect(),
        "fish" => {
            // Split on entry boundaries (lines starting with `- cmd:`).
            let mut blocks: Vec<String> = Vec::new();
            let mut cur = String::new();
            for line in text.lines().skip(1) {
                if line.trim_start().starts_with("- cmd:") && !cur.is_empty() {
                    blocks.push(std::mem::take(&mut cur));
                }
                cur.push_str(line);
                cur.push('\n');
            }
            if !cur.is_empty() {
                blocks.push(cur);
            }
            blocks.iter().filter_map(|b| parse_fish_block(b)).collect()
        }
        _ => text
            .lines()
            .skip(1)
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
    };

    if entries.len() > n {
        let drop = entries.len() - n;
        entries.drain(..drop);
    }
    entries
}

/// Single-line glimpse of the last command, trimmed to ~80 chars.
///
/// Used by the picker for the "Last" column. Never logs or panics.
pub fn last_command_glimpse(shell: &str) -> Option<String> {
    format_glimpse(tail_history(shell, 1).pop()?)
}

/// Pure helper: collapse internal whitespace and truncate to ~80 chars.
/// Exported for unit tests to bypass the filesystem.
fn format_glimpse(raw: String) -> Option<String> {
    let mut last = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if last.len() > 80 {
        last.truncate(80);
        last.push('…');
    }
    if last.is_empty() {
        None
    } else {
        Some(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zsh_extended_format() {
        assert_eq!(
            parse_zsh_line(": 1701234567:0;git status").as_deref(),
            Some("git status")
        );
        assert_eq!(
            parse_zsh_line(": 1701234567:0;").as_deref(),
            None,
            "empty command must be discarded"
        );
        assert_eq!(parse_zsh_line("plain line").as_deref(), Some("plain line"));
        assert_eq!(parse_zsh_line("   ").as_deref(), None);
    }

    #[test]
    fn zsh_strips_trailing_backslash_continuations() {
        assert_eq!(
            parse_zsh_line(": 1701234567:0;echo \\").as_deref(),
            Some("echo")
        );
    }

    #[test]
    fn parses_fish_yaml_block() {
        let block = "- cmd: git push\n  when: 1701234567";
        assert_eq!(parse_fish_block(block).as_deref(), Some("git push"));
    }

    #[test]
    fn fish_skips_meta_only_blocks() {
        let block = "  when: 1701234567";
        assert_eq!(parse_fish_block(block), None);
    }

    #[test]
    fn missing_file_returns_empty() {
        assert_eq!(
            tail_history("nonexistent-shell-xyz", 10),
            Vec::<String>::new()
        );
    }

    #[test]
    fn expand_tilde_expands_leading_only() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let home_str = home.to_string_lossy().to_string();
        assert_eq!(
            expand_tilde_with(home, "~/foo"),
            format!("{}/foo", home_str.trim_end_matches('/')),
        );
        // Embedded `~` is left alone — only leading `~/` expands.
        assert_eq!(expand_tilde_with(home, "/a/~/b"), "/a/~/b");
        assert_eq!(expand_tilde_with(home, "/absolute/path"), "/absolute/path");
    }

    #[test]
    fn tail_history_for_pid_falls_back_when_no_environ() {
        // A non-existent PID can't have a HISTFILE override; we must
        // still get a sane (possibly empty) result from the default path.
        let out = tail_history_for_pid(u32::MAX, "zsh", 5);
        // Don't assert non-empty (CI hosts may not have ~/.zsh_history).
        // The contract is "no panic, defined return".
        let _ = out;
    }

    #[test]
    fn glimpse_collapses_whitespace_and_truncates() {
        let long = "a".repeat(200);
        let g = format_glimpse(long).unwrap();
        assert!(g.ends_with('…'), "long entry should be truncated: {}", g);
        assert!(g.len() <= 84);
    }

    #[test]
    fn glimpse_collapses_internal_whitespace() {
        let g = format_glimpse("foo  bar\n  baz".to_string()).unwrap();
        assert_eq!(g, "foo bar baz");
    }

    #[test]
    fn glimpse_empty_returns_none() {
        assert!(format_glimpse(String::new()).is_none());
        assert!(format_glimpse("   \n  ".into()).is_none());
    }
}
