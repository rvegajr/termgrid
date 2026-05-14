//! Cross-platform shell enumeration.
//!
//! Walks the system process list (via `sysinfo`), filters to known shells,
//! excludes TermGrid's own descendants, tags ssh-derived sessions, and
//! delegates platform-specific CWD/TTY probes to the sibling modules.

use super::history;
use super::types::{AdoptableSession, SessionSnapshot};
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

/// Shell executable basenames we consider adoptable.
///
/// Matched case-insensitively against `Process::name()`. The `.exe` suffix
/// is normalized away before comparison, so Windows PowerShell and cmd
/// match the same way.
pub const SHELL_NAMES: &[&str] = &[
    "zsh",
    "bash",
    "fish",
    "nu",
    "nushell",
    "pwsh",
    "powershell",
    "cmd",
    "tcsh",
    "ksh",
    "dash",
    "elvish",
    "xonsh",
];

/// Process names whose presence in a candidate's ancestry means
/// "this is really an ssh session, mark it accordingly".
const SSH_PARENT_NAMES: &[&str] = &["ssh", "mosh-client"];

/// Process names we recognize as terminal-emulator hosts. Reported in the
/// picker's "Where" column so the user can distinguish their many
/// Terminal.app tabs from their iTerm session.
const TERMINAL_HOSTS: &[&str] = &[
    "Terminal",
    "iTerm2",
    "iTerm",
    "Alacritty",
    "WezTerm",
    "kitty",
    "Hyper",
    "Ghostty",
    "Warp",
    "WindowsTerminal",
    "wt",
    "conhost",
    "tmux",
    "screen",
    // Editor-integrated terminals: dev users frequently launch shells
    // inside these and will want to recognize them in the picker.
    "Code",
    "Code Helper",
    "Code Helper (Plugin)",
    "Cursor",
    "Cursor Helper",
    "Cursor Helper (Plugin)",
    "Cursor Helper (Renderer)",
    "Zed",
    "JetBrains",
    "idea",
    "pycharm",
    "rubymine",
    "goland",
    "webstorm",
];

/// Normalize a process name for shell-list comparison.
fn normalize_name(name: &str) -> String {
    let mut n = name.to_ascii_lowercase();
    if let Some(stripped) = n.strip_suffix(".exe") {
        n = stripped.to_string();
    }
    n
}

fn is_shell(name: &str) -> bool {
    let n = normalize_name(name);
    SHELL_NAMES.iter().any(|s| *s == n)
}

fn is_ssh(name: &str) -> bool {
    let n = normalize_name(name);
    SSH_PARENT_NAMES.iter().any(|s| *s == n)
}

fn is_terminal_host(name: &str) -> bool {
    TERMINAL_HOSTS.iter().any(|host| host.eq_ignore_ascii_case(name))
}

/// One pass of process-tree info, indexed for fast ancestry walks.
///
/// Computed once per discovery call so each candidate shell's parent walk
/// is O(depth) rather than re-scanning the full process list.
struct ProcessIndex {
    /// PID → PIDs of its direct children.
    children: HashMap<u32, Vec<u32>>,
    /// PID → parent PID.
    parent: HashMap<u32, u32>,
    /// PID → process basename.
    names: HashMap<u32, String>,
    /// PID → Unix start time in seconds.
    started: HashMap<u32, u64>,
}

fn build_index(sys: &System) -> ProcessIndex {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut parent: HashMap<u32, u32> = HashMap::new();
    let mut names: HashMap<u32, String> = HashMap::new();
    let mut started: HashMap<u32, u64> = HashMap::new();

    for (pid, proc) in sys.processes() {
        let pid_u32 = pid.as_u32();
        let name = proc.name().to_string_lossy().into_owned();
        names.insert(pid_u32, name);
        started.insert(pid_u32, proc.start_time());

        if let Some(ppid) = proc.parent() {
            let ppid_u32 = ppid.as_u32();
            parent.insert(pid_u32, ppid_u32);
            children.entry(ppid_u32).or_default().push(pid_u32);
        }
    }

    ProcessIndex {
        children,
        parent,
        names,
        started,
    }
}

/// Compute the set of PIDs descended from `root_pid` (inclusive).
fn descendants_of(root_pid: u32, children: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![root_pid];
    while let Some(pid) = stack.pop() {
        if out.insert(pid) {
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
    }
    out
}

/// Walk a candidate's parent chain.
///
/// Stops at PID 1 (or any cycle, defensive). The first terminal-host
/// ancestor wins. An ssh ancestor anywhere in the chain marks the session
/// and is reported back so callers can parse its argv for v2 reconnect.
pub(crate) struct Ancestry {
    pub via_ssh: bool,
    pub host: Option<String>,
    pub ssh_pid: Option<u32>,
}

pub(crate) fn classify_ancestry(
    start_pid: u32,
    parent: &HashMap<u32, u32>,
    names: &HashMap<u32, String>,
) -> Ancestry {
    let mut via_ssh = false;
    let mut host: Option<String> = None;
    let mut ssh_pid: Option<u32> = None;
    let mut visited: HashSet<u32> = HashSet::new();
    let mut cur = start_pid;

    while let Some(&ppid) = parent.get(&cur) {
        if !visited.insert(ppid) {
            break;
        }
        if let Some(pname) = names.get(&ppid) {
            if !via_ssh && is_ssh(pname) {
                via_ssh = true;
                ssh_pid = Some(ppid);
            }
            if host.is_none() && is_terminal_host(pname) {
                host = Some(pname.clone());
            }
        }
        cur = ppid;
        if cur == 0 || cur == 1 {
            break;
        }
    }

    Ancestry {
        via_ssh,
        host,
        ssh_pid,
    }
}

/// Enumerate every adoptable shell on the host.
///
/// Returns sessions ordered newest-first. Empty list is a valid (and
/// common) result on systems with no spare shells running.
pub fn enumerate() -> Vec<AdoptableSession> {
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let idx = build_index(&sys);
    let self_pid = std::process::id();
    let self_tree = descendants_of(self_pid, &idx.children);

    let mut out: Vec<AdoptableSession> = Vec::new();

    for (pid_t, proc) in sys.processes() {
        let pid = pid_t.as_u32();
        if self_tree.contains(&pid) {
            continue;
        }
        let raw_name = proc.name().to_string_lossy().into_owned();
        if !is_shell(&raw_name) {
            continue;
        }

        let ancestry = classify_ancestry(pid, &idx.parent, &idx.names);
        let cwd = super::cwd_of_pid(pid);
        let tty = super::tty_of_pid(pid);
        let last_command = history::last_command_glimpse(&raw_name);

        out.push(AdoptableSession {
            pid,
            shell: normalize_name(&raw_name),
            cwd,
            tty,
            parent: ancestry.host,
            last_command,
            started_at: idx.started.get(&pid).copied().unwrap_or(0),
            via_ssh: ancestry.via_ssh,
        });
    }

    // Newest first. Ties broken by PID (stable, harmless).
    out.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.pid.cmp(&a.pid))
    });

    out
}

/// Build the full snapshot for one PID.
///
/// If the process exited between picker open and selection, returns a
/// snapshot with the PID filled in and everything else best-effort empty.
///
/// v2: also populates `buffer_preview`, `env_vars`, and `ssh_target`.
/// Each of those probes is independently best-effort; failures collapse
/// to their empty/None values rather than poisoning the whole snapshot.
pub fn snapshot(pid: u32) -> SessionSnapshot {
    // Refresh *all* processes so we can rebuild the ancestry index for
    // ssh-PID discovery. Cheap (one syscall) and gives us host info too.
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let shell = sys
        .process(Pid::from_u32(pid))
        .map(|p| normalize_name(&p.name().to_string_lossy()))
        .unwrap_or_else(|| "shell".to_string());

    let idx = build_index(&sys);
    let ancestry = classify_ancestry(pid, &idx.parent, &idx.names);

    let cwd = super::cwd_of_pid(pid);
    let tty = super::tty_of_pid(pid);
    // v3: prefer the target process's own HISTFILE override when set.
    let recent_history = history::tail_history_for_pid(pid, &shell, 20);

    let banner = match (&tty, &shell) {
        (Some(t), s) => format!("adopted from {} ({}, pid {})", t, s, pid),
        (None, s) => format!("adopted ({}, pid {})", s, pid),
    };

    // v2 probes — each independently fail-safe.
    // v3: pass the resolved tty so the buffer scrape can match the exact
    // tab in Terminal.app / iTerm2 instead of guessing frontmost.
    let buffer_preview = super::buffer_scrape::scrape(
        pid,
        ancestry.host.as_deref(),
        tty.as_deref(),
    );
    // v4: on macOS (and any host where direct env probe is denied) we
    // fall back to spawning a fresh shell in the candidate's CWD and
    // dumping what *that* shell sees. This catches direnv/asdf/mise/nvm
    // and project `.envrc` files — almost always what the user wants
    // when adopting. Skip on Windows (no `.envrc`-style ecosystem) and
    // when we don't know the CWD.
    let mut env_vars = super::env_capture::env_of_pid(pid);
    if env_vars.is_empty() {
        if let Some(cwd_str) = cwd.as_deref() {
            let cwd_path = std::path::Path::new(cwd_str);
            env_vars = super::env_capture::replay_env_in_cwd(&shell, cwd_path);
        }
    }
    let ssh_target = ancestry
        .ssh_pid
        .and_then(super::ssh_parse::parse_ssh_for_pid);

    SessionSnapshot {
        pid,
        shell,
        cwd,
        tty,
        buffer_preview,
        env_vars,
        ssh_target,
        recent_history,
        banner,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_exe_suffix() {
        assert_eq!(normalize_name("powershell.exe"), "powershell");
        assert_eq!(normalize_name("Cmd.EXE"), "cmd");
        assert_eq!(normalize_name("zsh"), "zsh");
    }

    #[test]
    fn recognizes_known_shells() {
        assert!(is_shell("zsh"));
        assert!(is_shell("bash"));
        assert!(is_shell("pwsh.exe"));
        assert!(is_shell("powershell.exe"));
        assert!(!is_shell("vim"));
        assert!(!is_shell(""));
    }

    #[test]
    fn ssh_detected_case_insensitively() {
        assert!(is_ssh("ssh"));
        assert!(is_ssh("SSH"));
        assert!(is_ssh("mosh-client"));
        assert!(!is_ssh("sshd"));
    }

    #[test]
    fn terminal_host_match_is_exact() {
        assert!(is_terminal_host("Terminal"));
        assert!(is_terminal_host("iTerm2"));
        // "Terminal-extra" should not match "Terminal".
        assert!(!is_terminal_host("Terminal-extra"));
    }

    #[test]
    fn descendants_walks_tree() {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        children.insert(1, vec![2, 3]);
        children.insert(2, vec![4]);
        children.insert(3, vec![5, 6]);

        let d = descendants_of(1, &children);
        for pid in [1u32, 2, 3, 4, 5, 6] {
            assert!(d.contains(&pid), "missing {}", pid);
        }
        assert_eq!(d.len(), 6);
    }

    #[test]
    fn descendants_handles_no_children() {
        let children: HashMap<u32, Vec<u32>> = HashMap::new();
        let d = descendants_of(42, &children);
        assert_eq!(d.len(), 1);
        assert!(d.contains(&42));
    }

    #[test]
    fn classify_ancestry_finds_ssh_and_host() {
        let mut parent = HashMap::new();
        let mut names = HashMap::new();
        // zsh (100) -> ssh (50) -> Terminal (10) -> launchd (1)
        parent.insert(100u32, 50u32);
        parent.insert(50u32, 10u32);
        parent.insert(10u32, 1u32);
        names.insert(50u32, "ssh".to_string());
        names.insert(10u32, "Terminal".to_string());
        names.insert(1u32, "launchd".to_string());

        let a = classify_ancestry(100, &parent, &names);
        assert!(a.via_ssh);
        assert_eq!(a.host.as_deref(), Some("Terminal"));
        assert_eq!(a.ssh_pid, Some(50), "ssh pid must be reported");
    }

    #[test]
    fn classify_ancestry_no_ssh_no_pid() {
        let mut parent = HashMap::new();
        let mut names = HashMap::new();
        // zsh (100) -> login (50) -> Terminal (10) -> launchd (1)
        parent.insert(100u32, 50u32);
        parent.insert(50u32, 10u32);
        parent.insert(10u32, 1u32);
        names.insert(50u32, "login".to_string());
        names.insert(10u32, "Terminal".to_string());
        names.insert(1u32, "launchd".to_string());

        let a = classify_ancestry(100, &parent, &names);
        assert!(!a.via_ssh);
        assert_eq!(a.ssh_pid, None);
    }

    #[test]
    fn classify_ancestry_terminates_on_cycle() {
        let mut parent = HashMap::new();
        let mut names = HashMap::new();
        parent.insert(1u32, 2u32);
        parent.insert(2u32, 1u32); // cycle
        names.insert(1u32, "a".to_string());
        names.insert(2u32, "b".to_string());

        let _ = classify_ancestry(1, &parent, &names);
    }
}
