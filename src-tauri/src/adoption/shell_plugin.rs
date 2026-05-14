//! **v5:** Shell-cooperative plugin reader.
//!
//! Reads state exported by the TermGrid shell plugins (zsh/bash/fish) from
//! `$HOME/.termgrid/shell-state/<PID>.json`. This provides a high-fidelity,
//! cross-platform source for env vars and buffer previews without needing
//! platform-specific introspection or elevated permissions.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PluginState {
    pid: u32,
    shell: String,
    cwd: String,
    timestamp: i64,
    env: HashMap<String, String>,
    buffer_preview: String,
}

/// Returns the path to the plugin state file for the given PID, if it exists.
fn plugin_state_path(pid: u32) -> Option<PathBuf> {
    let home = dirs_next::home_dir()?;
    let path = home
        .join(".termgrid")
        .join("shell-state")
        .join(format!("{}.json", pid));
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Reads the plugin state for the given PID. Returns `None` if the file
/// doesn't exist, is stale (>60s old), or can't be parsed.
fn read_plugin_state(pid: u32) -> Option<PluginState> {
    let path = plugin_state_path(pid)?;
    let contents = std::fs::read_to_string(&path).ok()?;
    let state: PluginState = serde_json::from_str(&contents).ok()?;

    // Staleness check: if the file is >60s old, treat it as abandoned
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    if now - state.timestamp > 60 {
        return None;
    }

    Some(state)
}

/// **v5:** Attempts to read environment variables from the shell plugin state.
/// Returns an empty vec if the plugin isn't active for this PID.
///
/// This is a high-priority source: it's more accurate than `ps -E` (which
/// truncates on macOS) and doesn't require elevated permissions like
/// `task_for_pid`.
pub fn env_from_plugin(pid: u32) -> Vec<(String, String)> {
    let state = match read_plugin_state(pid) {
        Some(s) => s,
        None => return vec![],
    };
    state.env.into_iter().collect()
}

/// **v5:** Attempts to read the buffer preview from the shell plugin state.
/// Returns `None` if the plugin isn't active for this PID.
///
/// This is a fallback for hosts with no introspection API (e.g.,
/// gnome-terminal on Wayland, or any terminal where AppleScript / tmux /
/// qdbus aren't available).
pub fn buffer_from_plugin(pid: u32) -> Option<String> {
    let state = read_plugin_state(pid)?;
    if state.buffer_preview.is_empty() {
        None
    } else {
        Some(state.buffer_preview)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::TempDir;

    // Serialize tests that mutate HOME to avoid cross-contamination
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn write_plugin_state(dir: &TempDir, pid: u32, timestamp: i64, env: &str, buffer: &str) {
        let state_dir = dir.path().join(".termgrid").join("shell-state");
        fs::create_dir_all(&state_dir).unwrap();
        let json = format!(
            r#"{{
  "pid": {},
  "shell": "zsh",
  "cwd": "/tmp",
  "timestamp": {},
  "env": {{{}}},
  "buffer_preview": "{}"
}}"#,
            pid, timestamp, env, buffer
        );
        fs::write(state_dir.join(format!("{}.json", pid)), json).unwrap();
    }

    #[test]
    fn returns_empty_when_file_missing() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let result = env_from_plugin(9999);
        assert!(result.is_empty());
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }

    #[test]
    fn reads_valid_plugin_state() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        write_plugin_state(&tmp, 1234, now, r#""PATH":"/usr/bin","HOME":"/home/user""#, "ls -la");
        let result = env_from_plugin(1234);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&("PATH".into(), "/usr/bin".into())));
        assert!(result.contains(&("HOME".into(), "/home/user".into())));
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }

    #[test]
    fn ignores_stale_state() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let stale_timestamp = 1000; // ancient
        write_plugin_state(&tmp, 1234, stale_timestamp, r#""PATH":"/usr/bin""#, "");
        let result = env_from_plugin(1234);
        assert!(result.is_empty(), "Stale state should be ignored");
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }

    #[test]
    fn reads_buffer_preview() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        write_plugin_state(&tmp, 1234, now, "", "git status; git log");
        let result = buffer_from_plugin(1234);
        assert_eq!(result, Some("git status; git log".into()));
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }

    #[test]
    fn returns_none_for_empty_buffer() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        write_plugin_state(&tmp, 1234, now, r#""PATH":"/usr/bin""#, "");
        let result = buffer_from_plugin(1234);
        assert_eq!(result, None);
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }
}
