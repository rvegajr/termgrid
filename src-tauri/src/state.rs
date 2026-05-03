use crate::history::HistoryState;
use crate::pty::manager::PtyManager;
use crate::pty::shell_detect::SystemShellDetector;
use crate::pty::traits::*;
use std::sync::Arc;

/// Central DI container — holds Arc<dyn Trait> for every ISP trait.
/// Tauri commands destructure this to get only the trait they need.
pub struct AppState {
    pub pty_spawner: Arc<dyn PtySpawner>,
    pub pty_writer: Arc<dyn PtyWriter>,
    pub pty_reader: Arc<dyn PtyReader>,
    pub pty_resizer: Arc<dyn PtyResizer>,
    pub pty_lifecycle: Arc<dyn PtyLifecycle>,
    pub shell_detector: Arc<dyn ShellDetector>,
    pub history: Arc<HistoryState>,
}

impl AppState {
    pub fn new() -> Self {
        let pty_manager = Arc::new(PtyManager::new());
        let shell_detector = Arc::new(SystemShellDetector::new());
        let history =
            Arc::new(HistoryState::new().expect("failed to open command history database"));

        Self {
            pty_spawner: pty_manager.clone(),
            pty_writer: pty_manager.clone(),
            pty_reader: pty_manager.clone(),
            pty_resizer: pty_manager.clone(),
            pty_lifecycle: pty_manager,
            shell_detector,
            history,
        }
    }
}
