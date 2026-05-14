//! Tauri command surface for session adoption.
//!
//! Endpoints are safe to call repeatedly and synchronous from the
//! frontend's perspective. Discovery is fast (<100ms in practice) so we
//! don't bother with async streaming for v1.

use super::{
    list_adoptable_sessions, snapshot_session, AdoptableSession, SessionSnapshot,
};

/// List every shell process on the host that the user could plausibly
/// adopt into a new TermGrid pane.
#[tauri::command]
pub fn list_adoptable_sessions_cmd() -> Vec<AdoptableSession> {
    list_adoptable_sessions()
}

/// Build the full snapshot payload for one picked PID.
///
/// Returns a snapshot with empty/best-effort fields if the process exited
/// between picker open and selection — the caller can still open a fresh
/// pane and apply whatever fields did populate (often the CWD survives).
#[tauri::command]
pub fn snapshot_session_cmd(pid: u32) -> SessionSnapshot {
    snapshot_session(pid)
}

/// **v3:** Identify the currently frontmost terminal-host app.
///
/// Powers the "Adopt frontmost terminal" palette command: the user
/// switches to their other terminal app, hits the hotkey, and TermGrid
/// pre-filters the adoption picker by that app's name.
///
/// Returns `None` if the OS denies the probe, no app is foreground, or
/// the active app isn't one we recognize.
#[tauri::command]
pub fn frontmost_terminal_app_cmd() -> Option<String> {
    super::frontmost::frontmost_terminal_app()
}

/// **v4:** One-shot "snap to frontmost" adoption.
///
/// The drag-from-OS-window pattern requires Accessibility entitlements
/// (and a signed/notarized build). This command is the honest, no-perm
/// equivalent: the user brings the terminal they want into focus, hits
/// the hotkey, and we pick the single best candidate to adopt.
///
/// Returns variants:
///   - [`SnapResult::None`] — no frontmost terminal we recognize.
///   - [`SnapResult::One`] — a single unambiguous candidate; the caller
///     can adopt it directly.
///   - [`SnapResult::Multiple`] — multiple shells under the frontmost
///     app; the caller should open the picker pre-filtered by `parent`.
///
/// "Best candidate" = the shell with the most recent `started_at` under
/// the frontmost app. This matches the user's intuition because the
/// most recently spawned shell is overwhelmingly the one they just
/// interacted with. We do not try to disambiguate by "active tty";
/// detecting that costs an extra AppleScript call and rarely changes
/// the answer.
#[tauri::command]
pub fn snap_to_frontmost_cmd() -> SnapResult {
    let host = match super::frontmost::frontmost_terminal_app() {
        Some(h) => h,
        None => return SnapResult::None { reason: "no frontmost terminal app detected".into() },
    };
    let all = list_adoptable_sessions();
    let host_lc = host.to_ascii_lowercase();
    let mut matches: Vec<AdoptableSession> = all
        .into_iter()
        .filter(|s| {
            s.parent
                .as_deref()
                .map(|p| p.to_ascii_lowercase().contains(&host_lc))
                .unwrap_or(false)
        })
        .collect();
    if matches.is_empty() {
        return SnapResult::None {
            reason: format!("frontmost is '{}' but no shells claim it as parent", host),
        };
    }
    // Most-recently-started first.
    matches.sort_by_key(|s| std::cmp::Reverse(s.started_at));
    if matches.len() == 1 {
        let only = matches.into_iter().next().unwrap();
        let snap = snapshot_session(only.pid);
        SnapResult::One {
            host,
            session: only,
            snapshot: Box::new(snap),
        }
    } else {
        SnapResult::Multiple {
            host,
            candidates: matches,
        }
    }
}

/// The three-way result of a snap-to-frontmost probe.
///
/// Serialized to JSON as a tagged union (`{ "kind": "one", ... }`) so
/// the frontend can switch on it cleanly. Tag values are kebab-case to
/// match TS convention; serde's `rename_all = "kebab-case"` only
/// applies to fields, so we spell them out by hand on the variants.
///
/// `One.snapshot` is boxed because `SessionSnapshot` (with its buffer
/// preview + env vec) is significantly larger than the other variants;
/// boxing keeps the enum's overall stack footprint small. Wire format
/// is unaffected — serde transparently follows the `Box`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SnapResult {
    None { reason: String },
    One {
        host: String,
        session: AdoptableSession,
        snapshot: Box<SessionSnapshot>,
    },
    Multiple {
        host: String,
        candidates: Vec<AdoptableSession>,
    },
}

/// **v4:** Opt-in clipboard-based buffer capture for terminal hosts we
/// have no introspection path for (gnome-terminal, xterm, etc.).
///
/// Strategy on X11 Linux:
/// 1. Save current `xclip -selection clipboard -o`.
/// 2. Send `Ctrl+Shift+A` then `Ctrl+Shift+C` to the foreground window
///    via `xdotool key`. gnome-terminal default Select-All + Copy
///    bindings.
/// 3. Read clipboard via `xclip`.
/// 4. Restore the saved clipboard.
///
/// Caveats clearly documented to the user in the UI:
/// - Steals focus briefly (the keypress goes to whatever window is in
///   front when invoked).
/// - Requires `xclip` and `xdotool` on PATH.
/// - Doesn't work on Wayland — we return `None` with a reason there.
/// - Doesn't work outside X11 — `None` with a reason.
///
/// Returns `(Some(text), None)` on success or `(None, Some(reason))` on
/// any failure. The frontend surfaces `reason` so the user understands
/// why the scrape didn't land.
#[tauri::command]
pub fn clipboard_capture_cmd() -> ClipboardCapture {
    super::clipboard_capture::capture()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session(pid: u32, parent: Option<&str>, started_at: u64) -> AdoptableSession {
        AdoptableSession {
            pid,
            shell: "zsh".into(),
            cwd: Some("/Users/me".into()),
            tty: Some("/dev/ttys000".into()),
            parent: parent.map(|s| s.to_string()),
            last_command: None,
            started_at,
            via_ssh: false,
        }
    }

    /// Pure-logic test for the snap dispatcher: given a host name and a
    /// candidate set, pick the right `SnapResult` variant.
    ///
    /// We re-implement the matching here rather than poking real
    /// `snap_to_frontmost_cmd` because the latter calls into AppleScript
    /// + sysinfo. The decision logic is small enough to test directly.
    fn dispatch(host: &str, candidates: Vec<AdoptableSession>) -> SnapResult {
        let host_lc = host.to_ascii_lowercase();
        let mut matches: Vec<AdoptableSession> = candidates
            .into_iter()
            .filter(|s| {
                s.parent
                    .as_deref()
                    .map(|p| p.to_ascii_lowercase().contains(&host_lc))
                    .unwrap_or(false)
            })
            .collect();
        if matches.is_empty() {
            return SnapResult::None {
                reason: format!("frontmost is '{}' but no shells claim it as parent", host),
            };
        }
        matches.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        if matches.len() == 1 {
            SnapResult::One {
                host: host.to_string(),
                snapshot: Box::new(SessionSnapshot {
                    pid: matches[0].pid,
                    shell: matches[0].shell.clone(),
                    cwd: matches[0].cwd.clone(),
                    tty: matches[0].tty.clone(),
                    recent_history: Vec::new(),
                    banner: "test".into(),
                    buffer_preview: None,
                    env_vars: Vec::new(),
                    ssh_target: None,
                }),
                session: matches.into_iter().next().unwrap(),
            }
        } else {
            SnapResult::Multiple {
                host: host.to_string(),
                candidates: matches,
            }
        }
    }

    #[test]
    fn dispatch_returns_none_when_no_matches() {
        let res = dispatch(
            "Terminal",
            vec![sample_session(1, Some("iTerm2"), 1000)],
        );
        assert!(matches!(res, SnapResult::None { .. }));
    }

    #[test]
    fn dispatch_returns_one_for_single_match() {
        let res = dispatch(
            "Terminal",
            vec![sample_session(1, Some("Terminal"), 1000)],
        );
        match res {
            SnapResult::One { session, .. } => assert_eq!(session.pid, 1),
            other => panic!("expected One, got {:?}", other),
        }
    }

    #[test]
    fn dispatch_returns_multiple_sorted_by_started_at_desc() {
        let res = dispatch(
            "Terminal",
            vec![
                sample_session(1, Some("Terminal"), 100),
                sample_session(2, Some("Terminal"), 999),
                sample_session(3, Some("Terminal"), 500),
            ],
        );
        match res {
            SnapResult::Multiple { candidates, .. } => {
                assert_eq!(
                    candidates.iter().map(|c| c.pid).collect::<Vec<_>>(),
                    vec![2, 3, 1]
                );
            }
            other => panic!("expected Multiple, got {:?}", other),
        }
    }

    #[test]
    fn dispatch_substring_match_for_compound_host_names() {
        // "Cursor Helper (Renderer)" should still match a host name of "Cursor".
        let res = dispatch(
            "Cursor",
            vec![sample_session(1, Some("Cursor Helper (Renderer)"), 1000)],
        );
        assert!(matches!(res, SnapResult::One { .. }));
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct ClipboardCapture {
    pub text: Option<String>,
    pub reason: Option<String>,
}

/// **v4:** Spawn a non-interactive login shell in `cwd` and capture the
/// env vars it sees, filtered to the toolchain allow-list.
///
/// This is the macOS workaround for env capture: Apple has progressively
/// locked down reading another process's env (`ps -E` returns nothing
/// for SIP-protected hosts, `proc_pidinfo` flavors that expose it require
/// entitlements). What we *can* do is reproduce the env a *new* shell
/// would inherit when started in the candidate's CWD — which catches
/// direnv, asdf, mise, nvm, virtualenv auto-activation, and project
/// `.envrc` files. That's the env the user actually wants ~95% of the
/// time when adopting a session.
///
/// `shell` is the candidate's shell (e.g. `"zsh"`, `"bash"`). We invoke
/// it with `-lic 'export -p'` to force login + interactive (so `.zshrc`
/// runs) then dump env. Output is parsed with the same allow-list as
/// `env_capture`.
///
/// Returns an empty list on any failure (shell missing, cwd missing,
/// timeout, parse error). Never errors to the frontend.
#[tauri::command]
pub fn replay_env_in_cwd_cmd(shell: String, cwd: String) -> Vec<super::types::EnvVar> {
    super::env_capture::replay_env_in_cwd(&shell, std::path::Path::new(&cwd))
}

/**
 * **v5:** Install TermGrid shell plugins to `~/.termgrid/plugins/`.
 * 
 * Returns installation instructions for the user. The plugins enable
 * cooperative adoption: shells voluntarily export their environment and
 * buffer state, eliminating the need for platform-specific introspection.
 */
#[tauri::command]
pub fn install_shell_plugins_cmd() -> Result<super::plugin_installer::InstallResult, String> {
    super::plugin_installer::install_plugins()
}

/**
 * **v5 (Windows):** Start monitoring for drag-to-drop adoption events.
 * 
 * Installs a Windows event hook that tracks foreground window changes.
 * When a terminal window is brought to the foreground followed by TermGrid,
 * we treat it as a "drag-to-drop" proxy and make the PID available via
 * `poll_drag_events_cmd`.
 */
#[tauri::command]
pub fn start_drag_monitor_cmd() -> Result<(), String> {
    super::drag_windows::start_drag_monitor()
}

/**
 * **v5 (Windows):** Stop monitoring for drag events.
 */
#[tauri::command]
pub fn stop_drag_monitor_cmd() -> Result<(), String> {
    super::drag_windows::stop_drag_monitor()
}

/**
 * **v5 (Windows):** Poll for pending drag-to-drop adoption PIDs.
 * 
 * Returns `Some(pid)` if a terminal window was "dragged" (focus-switched)
 * to TermGrid since the last poll. Returns `None` if no pending events.
 */
#[tauri::command]
pub fn poll_drag_events_cmd() -> Option<u32> {
    super::drag_windows::poll_drag_events()
}
