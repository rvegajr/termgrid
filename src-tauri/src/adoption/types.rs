//! Shared data shapes for session adoption.
//!
//! `AdoptableSession` is the lightweight row shown in the picker — cheap to
//! enumerate. `SessionSnapshot` is the heavier payload returned after the user
//! picks one, used to seed the new TermGrid pane.

use serde::{Deserialize, Serialize};

/// One candidate shell process discovered on the host.
///
/// Cheap to enumerate; we render many of these in the picker. Anything
/// expensive to compute (full env, scrollback) lives in `SessionSnapshot`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdoptableSession {
    pub pid: u32,
    /// Short shell name: `"zsh"`, `"bash"`, `"pwsh"`, etc.
    pub shell: String,
    /// Best-effort CWD (may be `None` if the OS denied the probe).
    pub cwd: Option<String>,
    /// Controlling TTY path (`/dev/ttys003`) or pseudo-handle id on Windows.
    pub tty: Option<String>,
    /// The parent's short name — useful for distinguishing
    /// `Terminal` vs `iTerm` vs `Windows Terminal` in the picker.
    pub parent: Option<String>,
    /// Glimpse of the last command, if we can read history. Trimmed to 80
    /// chars; full history is in `SessionSnapshot::recent_history`.
    pub last_command: Option<String>,
    /// Unix epoch seconds when the process started. Used for "Age" column.
    pub started_at: u64,
    /// `true` if this shell is a descendant of an `ssh` invocation. The
    /// picker shows these with an `ssh →` prefix so the user knows we'll
    /// give them the local ssh client's CWD, not the remote shell's.
    pub via_ssh: bool,
}

/// One environment variable captured from a foreign process.
///
/// Reported as a tuple-like struct so the frontend can render `name=value`
/// without ambiguity around `=` in values. We deliberately serialize as
/// a struct, not a tuple, so the JSON shape is forward-compatible if we
/// add per-var metadata (e.g. `source` or `forward_recommended`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A parsed `ssh` invocation discovered in the candidate's ancestry.
///
/// When `via_ssh` is true on an [`AdoptableSession`], v2 tries to parse
/// the actual local ssh command line so the user can "reconnect" to the
/// real remote host rather than just inheriting the local ssh client's
/// CWD. All fields are best-effort; on parse failure the picker falls
/// back to v1 behavior (treat as a normal local shell).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshTarget {
    /// `user@host` if present, else just `host`. Never empty if `Some`.
    pub destination: String,
    /// Optional explicit port from `-p <port>`. `None` means default.
    pub port: Option<u16>,
    /// Optional remote command from the tail of `ssh user@host …`.
    /// We deliberately do not include flag arguments here — only the
    /// trailing positional command if one was present.
    pub command: Option<String>,
    /// The full argv we parsed, for transparency in the UI ("Reconnect
    /// will run: `ssh -p 2222 me@host`"). Never empty.
    pub argv: Vec<String>,
}

/// Heavy payload returned for a single picked session.
///
/// Read once at adoption time; used to seed the new TermGrid pane's CWD,
/// scrollback banner, Ctrl-R history, and v2 buffer/env context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub pid: u32,
    pub shell: String,
    pub cwd: Option<String>,
    pub tty: Option<String>,
    /// Last N commands from the user's shell history file. May be empty if
    /// the file was locked/missing/unparseable. We never block on it.
    pub recent_history: Vec<String>,
    /// Best-effort banner text shown as a comment in the new pane:
    /// e.g. `"adopted from /dev/ttys003 (zsh, pid 4421)"`.
    pub banner: String,
    /// **v2** — visible terminal contents we managed to scrape from the
    /// host terminal (Terminal.app or iTerm2 via AppleScript on macOS;
    /// empty on other platforms). Already trimmed to a sane line count;
    /// safe to drop into the picker preview or seed the adopted pane.
    pub buffer_preview: Option<String>,
    /// **v2** — environment variables from the foreign process, filtered
    /// to the toolchain-relevant subset (`VIRTUAL_ENV`, `NVM_DIR`, etc.).
    /// Empty if the OS denied the probe.
    pub env_vars: Vec<EnvVar>,
    /// **v2** — parsed ssh invocation if the candidate is descended from
    /// an `ssh` process. Enables "reconnect to the remote" rather than
    /// "open a local shell where the ssh client was sitting".
    pub ssh_target: Option<SshTarget>,
}
