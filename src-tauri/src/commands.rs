use crate::pty::traits::*;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use std::thread;
use tauri::{AppHandle, Emitter, State};

/// Encode PTY output bytes as base64 for IPC transport.
/// Base64 is ~33% smaller and cheaper to parse than JSON number arrays.
fn encode_output(data: &[u8]) -> String {
    BASE64.encode(data)
}

#[derive(Serialize)]
pub struct CreatePaneResult {
    pub pane_id: String,
}

#[derive(Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct ShellsWithDefault {
    pub shells: Vec<ShellInfo>,
    pub default: ShellInfo,
}

#[tauri::command]
pub fn list_shells_with_default(app: AppHandle, state: State<AppState>) -> ShellsWithDefault {
    let result = state.get_shells_cached();

    // Spawn background refresh (stale-while-revalidate)
    // Clone the Arc fields needed for background work
    let shell_detector = state.shell_detector.clone();
    let shell_cache = state.shell_cache.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        // Try to acquire lock; if already refreshing, skip
        let Ok(_guard) = shell_cache.refresh_lock.try_lock() else {
            return;
        };

        let old_shells = shell_cache.memory_cache.get().cloned();

        // Detect fresh shells
        let shells = shell_detector.available_shells();
        let default = shell_detector.default_shell();
        let new_shells = ShellsWithDefault { shells, default };

        // Store in both caches
        let _ = shell_cache.memory_cache.set(new_shells.clone());
        shell_cache.disk_cache.save(&new_shells);

        // Emit event if shells changed
        if old_shells.as_ref() != Some(&new_shells) {
            let _ = app_clone.emit("shells-changed", &new_shells);
        }
    });

    result
}

#[tauri::command]
pub fn list_shells(state: State<AppState>) -> Vec<ShellInfo> {
    state.get_shells_cached().shells
}

#[tauri::command]
pub fn default_shell(state: State<AppState>) -> ShellInfo {
    state.get_shells_cached().default
}

#[derive(Clone, Serialize)]
struct PtyOutputEvent {
    pane_id: String,
    data: String, // base64-encoded bytes
}

#[tauri::command]
pub fn create_pane(
    app: AppHandle,
    state: State<AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CreatePaneResult, String> {
    let pane_id = uuid::Uuid::new_v4().to_string();
    let shell_path = shell.unwrap_or_else(|| state.get_shells_cached().default.path);
    let cwd = cwd.unwrap_or_else(|| {
        dirs_next::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    });

    state
        .pty_spawner
        .spawn(
            &pane_id,
            &shell_path,
            &cwd,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
        )
        .map_err(|e| e.to_string())?;

    // Start streaming PTY output to frontend
    let rx = state
        .pty_reader
        .subscribe(&pane_id)
        .map_err(|e| e.to_string())?;

    let pid = pane_id.clone();
    thread::spawn(move || {
        const MAX_COALESCE: usize = 65536; // 64KB cap for coalesced output

        while let Ok(mut data) = rx.recv() {
            // Coalesce bursty output: drain queued chunks (no blocking)
            while data.len() < MAX_COALESCE {
                match rx.try_recv() {
                    Ok(chunk) => data.extend_from_slice(&chunk),
                    Err(_) => break, // No more queued chunks
                }
            }

            let _ = app.emit(
                "pty-output",
                PtyOutputEvent {
                    pane_id: pid.clone(),
                    data: encode_output(&data),
                },
            );
        }
    });

    Ok(CreatePaneResult { pane_id })
}

#[tauri::command]
pub fn write_pane(state: State<AppState>, pane_id: String, data: String) -> Result<(), String> {
    state
        .pty_writer
        .write(&pane_id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_pane(
    state: State<AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty_resizer
        .resize(&pane_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_pane(state: State<AppState>, pane_id: String) -> Result<(), String> {
    state
        .pty_lifecycle
        .kill(&pane_id)
        .map_err(|e| e.to_string())
}

/// Where a pane currently *thinks it is*: a local shell, or remoted into
/// somewhere via ssh/mosh. Walks the PTY's child process tree and looks
/// for an `ssh`/`mosh-client` descendant — if any, parses its argv to
/// extract `user@host`. Otherwise reports the local short hostname.
///
/// Cheap: one sysinfo refresh + one `ps -o args=` per ssh hit. We expect
/// the frontend to poll this on a few-second cadence per visible pane.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RemoteContext {
    /// Local shell. `host` is the machine's short hostname so the UI can
    /// distinguish two TermGrid windows on different laptops at a glance.
    Local { host: String },
    /// User has SSHed (or mosh'd) into a remote host from this pane.
    Ssh {
        /// `user@host` or just `host`.
        destination: String,
        /// Short host portion (after any `user@`), for compact display.
        host: String,
        port: Option<u16>,
    },
}

#[tauri::command]
pub fn pane_remote_context(state: State<AppState>, pane_id: String) -> Option<RemoteContext> {
    let shell_pid = state.pty_introspect.process_id(&pane_id)?;
    let local_host = short_hostname();
    if let Some(target) = crate::adoption::find_ssh_descendant(shell_pid) {
        let dest = target.destination.clone();
        let host_only = dest
            .rsplit_once('@')
            .map(|(_, h)| h.to_string())
            .unwrap_or_else(|| dest.clone());
        Some(RemoteContext::Ssh {
            destination: dest,
            host: host_only,
            port: target.port,
        })
    } else {
        Some(RemoteContext::Local { host: local_host })
    }
}

/// Batched version of pane_remote_context: scan process tree once and resolve all panes.
/// Returns tuples of (pane_id, Option<RemoteContext>).
#[tauri::command]
pub fn panes_remote_context(
    state: State<AppState>,
    pane_ids: Vec<String>,
) -> Vec<(String, Option<RemoteContext>)> {
    use crate::adoption::find_ssh_in_tree;
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    // Build process index once (cheap refresh)
    let sys =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let mut names: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        let pid_u32 = pid.as_u32();
        names.insert(pid_u32, proc.name().to_string_lossy().into_owned());
        if let Some(ppid) = proc.parent() {
            children.entry(ppid.as_u32()).or_default().push(pid_u32);
        }
    }

    let local_host = short_hostname();

    // Resolve each pane using the shared index
    pane_ids
        .into_iter()
        .map(|pane_id| {
            let context = state.pty_introspect.process_id(&pane_id).map(|shell_pid| {
                if let Some(target) = find_ssh_in_tree(shell_pid, &names, &children) {
                    let dest = target.destination.clone();
                    let host_only = dest
                        .rsplit_once('@')
                        .map(|(_, h)| h.to_string())
                        .unwrap_or_else(|| dest.clone());
                    RemoteContext::Ssh {
                        destination: dest,
                        host: host_only,
                        port: target.port,
                    }
                } else {
                    RemoteContext::Local {
                        host: local_host.clone(),
                    }
                }
            });
            (pane_id, context)
        })
        .collect()
}

/// Best-effort short hostname.
///
/// We strip the first `.` onward (so `foo.local` → `foo`, `mac.lan` → `mac`)
/// since the badge has limited horizontal real estate and the full FQDN
/// rarely adds signal on a personal machine.
fn short_hostname() -> String {
    let raw = std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "local".to_string());
    raw.split('.').next().unwrap_or(&raw).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_output_round_trip() {
        // ASCII text
        let ascii = b"hello world\n";
        let encoded = encode_output(ascii);
        let decoded = BASE64.decode(&encoded).unwrap();
        assert_eq!(ascii, decoded.as_slice());

        // UTF-8 text with multibyte characters
        let utf8 = "hello 🦀 世界".as_bytes();
        let encoded = encode_output(utf8);
        let decoded = BASE64.decode(&encoded).unwrap();
        assert_eq!(utf8, decoded.as_slice());

        // Binary data (shell ANSI escape sequences)
        let ansi = b"\x1b[31mred\x1b[0m";
        let encoded = encode_output(ansi);
        let decoded = BASE64.decode(&encoded).unwrap();
        assert_eq!(ansi, decoded.as_slice());

        // Large chunk (simulating coalesced output)
        let large = vec![0x42u8; 65000];
        let encoded = encode_output(&large);
        let decoded = BASE64.decode(&encoded).unwrap();
        assert_eq!(large, decoded);
    }
}
