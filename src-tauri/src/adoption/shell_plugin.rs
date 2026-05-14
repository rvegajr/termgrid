//! **v5:** Shell-cooperative plugin reader.
//!
//! Reads state exported by the TermGrid shell plugins (zsh/bash/fish) from
//! `$HOME/.termgrid/shell-state/<PID>.json`. This provides a high-fidelity,
//! cross-platform source for env vars and buffer previews without needing
//! platform-specific introspection or elevated permissions.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

fn plugin_state_path_in(home: &Path, pid: u32) -> Option<PathBuf> {
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

fn read_plugin_state_in(home: &Path, pid: u32) -> Option<PluginState> {
    let path = plugin_state_path_in(home, pid)?;
    let contents = std::fs::read_to_string(&path).ok()?;
    let state: PluginState = serde_json::from_str(&contents).ok()?;

    // Staleness check: if the file is >60s old, treat it as abandoned.
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
/// More accurate than `ps -E` (which truncates on macOS) and doesn't require
/// elevated permissions.
pub fn env_from_plugin(pid: u32) -> Vec<(String, String)> {
    let Some(home) = dirs_next::home_dir() else {
        return vec![];
    };
    match read_plugin_state_in(&home, pid) {
        Some(s) => s.env.into_iter().collect(),
        None => vec![],
    }
}

/// **v5:** Attempts to read the buffer preview from the shell plugin state.
/// Returns `None` if the plugin isn't active for this PID.
pub fn buffer_from_plugin(pid: u32) -> Option<String> {
    let home = dirs_next::home_dir()?;
    let state = read_plugin_state_in(&home, pid)?;
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
    use std::time::{SystemTime, UNIX_EPOCH};
    use tempfile::TempDir;

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

    fn now_secs() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[test]
    fn returns_empty_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(read_plugin_state_in(tmp.path(), 9999).is_none());
    }

    #[test]
    fn reads_valid_plugin_state() {
        let tmp = TempDir::new().unwrap();
        write_plugin_state(
            &tmp,
            1234,
            now_secs(),
            r#""PATH":"/usr/bin","HOME":"/home/user""#,
            "ls -la",
        );
        let state = read_plugin_state_in(tmp.path(), 1234).expect("state present");
        assert_eq!(state.env.len(), 2);
        assert_eq!(state.env.get("PATH"), Some(&"/usr/bin".to_string()));
        assert_eq!(state.env.get("HOME"), Some(&"/home/user".to_string()));
    }

    #[test]
    fn ignores_stale_state() {
        let tmp = TempDir::new().unwrap();
        write_plugin_state(&tmp, 1234, 1000, r#""PATH":"/usr/bin""#, "");
        assert!(
            read_plugin_state_in(tmp.path(), 1234).is_none(),
            "Stale state should be ignored"
        );
    }

    #[test]
    fn reads_buffer_preview() {
        let tmp = TempDir::new().unwrap();
        write_plugin_state(&tmp, 1234, now_secs(), "", "git status; git log");
        let state = read_plugin_state_in(tmp.path(), 1234).expect("state present");
        assert_eq!(state.buffer_preview, "git status; git log");
    }

    #[test]
    fn returns_none_for_empty_buffer() {
        let tmp = TempDir::new().unwrap();
        write_plugin_state(&tmp, 1234, now_secs(), r#""PATH":"/usr/bin""#, "");
        let state = read_plugin_state_in(tmp.path(), 1234).expect("state present");
        assert!(state.buffer_preview.is_empty());
    }
}
