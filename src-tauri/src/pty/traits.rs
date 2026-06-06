use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use thiserror::Error;

pub type PaneId = String;

/// Spawn a new PTY process — ISP: only spawn responsibility
#[cfg_attr(test, mockall::automock)]
pub trait PtySpawner: Send + Sync {
    fn spawn(
        &self,
        pane_id: &PaneId,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), PtyError>;
}

/// Write input to a PTY — ISP: only write responsibility
#[cfg_attr(test, mockall::automock)]
pub trait PtyWriter: Send + Sync {
    fn write(&self, pane_id: &PaneId, data: &[u8]) -> Result<(), PtyError>;
}

/// Read output from a PTY — ISP: only read responsibility
#[cfg_attr(test, mockall::automock)]
pub trait PtyReader: Send + Sync {
    fn subscribe(&self, pane_id: &PaneId) -> Result<mpsc::Receiver<Vec<u8>>, PtyError>;
}

/// Resize a PTY — ISP: only resize responsibility
#[cfg_attr(test, mockall::automock)]
pub trait PtyResizer: Send + Sync {
    fn resize(&self, pane_id: &PaneId, cols: u16, rows: u16) -> Result<(), PtyError>;
}

/// Lifecycle management — ISP: only lifecycle responsibility
#[cfg_attr(test, mockall::automock)]
pub trait PtyLifecycle: Send + Sync {
    fn kill(&self, pane_id: &PaneId) -> Result<(), PtyError>;
    fn is_alive(&self, pane_id: &PaneId) -> bool;
    fn list_active(&self) -> Vec<PaneId>;
}

/// Read out-of-band info about a live PTY (currently just the child PID).
///
/// Used by the per-pane "where am I" badge to walk the shell's descendant
/// process tree and detect when the user has SSHed into a remote host.
#[cfg_attr(test, mockall::automock)]
pub trait PtyIntrospect: Send + Sync {
    fn process_id(&self, pane_id: &PaneId) -> Option<u32>;
}

/// Observe PTY exit events — ISP: only exit observation responsibility
///
/// Register a single handler that fires when any pane's child process exits
/// for a reason other than an explicit kill(). This allows the frontend to
/// tombstone exited shells while reclaiming backend resources (file descriptors,
/// zombie processes, blocked reader threads).
///
/// Note: mockall does not support mocking Fn objects, so this trait is not
/// mockable via the automock macro. Tests use the concrete PtyManager directly.
pub trait PtyExitObserver: Send + Sync {
    /// Register the single handler fired once when any pane's child exits
    /// for a reason other than an explicit kill().
    ///
    /// The handler receives the pane_id of the exited pane. Only natural exits
    /// (shell exited on its own) trigger this; explicit kill() calls suppress it.
    fn set_exit_handler(&self, handler: Box<dyn Fn(PaneId) + Send + Sync>);
}

/// Detect available shells on the system
#[cfg_attr(test, mockall::automock)]
pub trait ShellDetector: Send + Sync {
    fn available_shells(&self) -> Vec<ShellInfo>;
    fn default_shell(&self) -> ShellInfo;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub kind: ShellKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    PowerShell,
    Cmd,
    Nushell,
    GitBash,
    Other,
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("Pane not found: {0}")]
    PaneNotFound(PaneId),
    #[error("Pane already exists: {0}")]
    PaneAlreadyExists(PaneId),
    #[error("Spawn failed: {0}")]
    SpawnFailed(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
