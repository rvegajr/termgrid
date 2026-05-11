use crate::cache::CacheStore;
use crate::commands::ShellsWithDefault;
use crate::history::HistoryState;
use crate::pty::manager::PtyManager;
use crate::pty::shell_detect::SystemShellDetector;
use crate::pty::traits::*;
use std::sync::{Arc, Mutex, OnceLock};

/// Shared shell cache state
pub struct ShellCacheState {
    pub memory_cache: OnceLock<ShellsWithDefault>,
    pub disk_cache: CacheStore<ShellsWithDefault>,
    pub refresh_lock: Mutex<()>,
}

/// Central DI container — holds Arc<dyn Trait> for every ISP trait.
/// Tauri commands destructure this to get only the trait they need.
pub struct AppState {
    pub pty_spawner: Arc<dyn PtySpawner>,
    pub pty_writer: Arc<dyn PtyWriter>,
    pub pty_reader: Arc<dyn PtyReader>,
    pub pty_resizer: Arc<dyn PtyResizer>,
    pub pty_lifecycle: Arc<dyn PtyLifecycle>,
    pub shell_detector: Arc<dyn ShellDetector>,
    history: OnceLock<Arc<HistoryState>>,
    pub shell_cache: Arc<ShellCacheState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let pty_manager = Arc::new(PtyManager::new());
        let shell_detector = Arc::new(SystemShellDetector::new());

        Self {
            pty_spawner: pty_manager.clone(),
            pty_writer: pty_manager.clone(),
            pty_reader: pty_manager.clone(),
            pty_resizer: pty_manager.clone(),
            pty_lifecycle: pty_manager,
            shell_detector,
            history: OnceLock::new(),
            shell_cache: Arc::new(ShellCacheState {
                memory_cache: OnceLock::new(),
                disk_cache: CacheStore::new("shells"),
                refresh_lock: Mutex::new(()),
            }),
        }
    }

    /// Get history state, initializing it lazily on first access.
    /// The DB is only opened when history commands are first called,
    /// reducing startup latency.
    pub fn get_history(&self) -> Arc<HistoryState> {
        self.history
            .get_or_init(|| {
                Arc::new(HistoryState::new().expect("failed to open command history database"))
            })
            .clone()
    }

    /// Get shells + default with stale-while-revalidate pattern.
    ///
    /// 1. If in-memory cache exists, return it immediately
    /// 2. If disk cache exists, return it and schedule background refresh
    /// 3. Otherwise, detect synchronously
    ///
    /// Background refresh emits "shells-changed" event when complete.
    pub fn get_shells_cached(&self) -> ShellsWithDefault {
        // Fast path: in-memory cache
        if let Some(cached) = self.shell_cache.memory_cache.get() {
            return cached.clone();
        }

        // Try disk cache
        if let Some(disk_cached) = self.shell_cache.disk_cache.load() {
            // Store in memory for subsequent calls
            let _ = self.shell_cache.memory_cache.set(disk_cached.clone());
            return disk_cached;
        }

        // Cold start: detect synchronously
        self.detect_shells_sync()
    }

    /// Detect shells synchronously and cache the result.
    fn detect_shells_sync(&self) -> ShellsWithDefault {
        let shells = self.shell_detector.available_shells();
        let default = self.shell_detector.default_shell();
        let result = ShellsWithDefault { shells, default };

        // Store in both caches
        let _ = self.shell_cache.memory_cache.set(result.clone());
        self.shell_cache.disk_cache.save(&result);

        result
    }
}
