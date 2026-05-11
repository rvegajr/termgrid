/// Machine-fingerprinted persistent cache on the Rust side.
///
/// Uses `$DATA_DIR/TermGrid/cache/*.json` for storage.
/// Each cache entry includes a fingerprint to invalidate stale data
/// when config syncs to a different machine.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// Metadata envelope for cached values.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct CacheEntry<T> {
    value: T,
    fingerprint: String,
    #[serde(rename = "savedAt")]
    saved_at: u64,
}

/// Compute a machine fingerprint from system metadata.
///
/// Uses: hostname (from env vars) + OS + architecture + app version.
/// All available without extra dependencies.
fn compute_fingerprint() -> String {
    // Try multiple env vars to get hostname
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".to_string());

    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let app_version = env!("CARGO_PKG_VERSION");

    format!("{}|{}|{}|{}", hostname, os, arch, app_version)
}

/// Get the cache directory path: `$DATA_DIR/TermGrid/cache/`
fn cache_dir() -> Option<PathBuf> {
    dirs_next::data_dir().map(|d| d.join("TermGrid").join("cache"))
}

/// Ensure the cache directory exists.
fn ensure_cache_dir() -> std::io::Result<PathBuf> {
    let dir = cache_dir().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Could not determine data directory",
        )
    })?;

    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// A generic cache store for a single cache file.
///
/// Usage:
/// ```
/// # use termgrid_lib::cache::CacheStore;
/// # use serde::{Serialize, Deserialize};
/// # #[derive(Serialize, Deserialize)]
/// # struct MyData { value: String }
/// let cache = CacheStore::<MyData>::new("my_key");
/// let data = MyData { value: "test".to_string() };
/// cache.save(&data);
/// if let Some(loaded) = cache.load() {
///     // use cached data
/// }
/// ```
pub struct CacheStore<T> {
    name: String,
    _phantom: std::marker::PhantomData<T>,
}

impl<T> CacheStore<T>
where
    T: Serialize + for<'de> Deserialize<'de>,
{
    /// Create a new cache store for the given name.
    /// The actual file will be `$DATA_DIR/TermGrid/cache/{name}.json`.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            _phantom: std::marker::PhantomData,
        }
    }

    /// Get the full path to the cache file.
    fn file_path(&self) -> Option<PathBuf> {
        cache_dir().map(|d| d.join(format!("{}.json", self.name)))
    }

    /// Load the cached value.
    ///
    /// Returns `None` if:
    /// - File doesn't exist
    /// - Fingerprint doesn't match (wrong machine)
    /// - JSON deserialization fails
    ///
    /// Errors are logged but never panic.
    pub fn load(&self) -> Option<T> {
        let path = self.file_path()?;

        if !path.exists() {
            return None;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[cache] Failed to read {}: {}", self.name, e);
                return None;
            }
        };

        let entry: CacheEntry<T> = match serde_json::from_str(&content) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[cache] Failed to parse {}: {}", self.name, e);
                // Remove corrupt file
                let _ = fs::remove_file(&path);
                return None;
            }
        };

        let current_fingerprint = compute_fingerprint();
        if entry.fingerprint != current_fingerprint {
            eprintln!(
                "[cache] Fingerprint mismatch for {}: expected {}, got {}",
                self.name, current_fingerprint, entry.fingerprint
            );
            // Remove stale file
            let _ = fs::remove_file(&path);
            return None;
        }

        Some(entry.value)
    }

    /// Save a value to the cache.
    ///
    /// Uses atomic write (write to temp file, then rename) to avoid corruption
    /// if the process crashes mid-write.
    ///
    /// Errors are logged but never panic.
    pub fn save(&self, value: &T) -> bool {
        let dir = match ensure_cache_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[cache] Failed to ensure cache dir: {}", e);
                return false;
            }
        };

        let path = match self.file_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "[cache] Could not determine cache file path for {}",
                    self.name
                );
                return false;
            }
        };

        let entry = CacheEntry {
            value,
            fingerprint: compute_fingerprint(),
            saved_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };

        let json = match serde_json::to_string_pretty(&entry) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[cache] Failed to serialize {}: {}", self.name, e);
                return false;
            }
        };

        // Atomic write: write to temp file in the same directory, then rename
        let temp_path = dir.join(format!("{}.tmp", self.name));

        match fs::File::create(&temp_path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(json.as_bytes()) {
                    eprintln!("[cache] Failed to write temp file for {}: {}", self.name, e);
                    let _ = fs::remove_file(&temp_path);
                    return false;
                }

                if let Err(e) = file.sync_all() {
                    eprintln!("[cache] Failed to sync temp file for {}: {}", self.name, e);
                    let _ = fs::remove_file(&temp_path);
                    return false;
                }
            }
            Err(e) => {
                eprintln!(
                    "[cache] Failed to create temp file for {}: {}",
                    self.name, e
                );
                return false;
            }
        }

        // Atomic rename
        if let Err(e) = fs::rename(&temp_path, &path) {
            eprintln!(
                "[cache] Failed to rename temp file for {}: {}",
                self.name, e
            );
            let _ = fs::remove_file(&temp_path);
            return false;
        }

        true
    }

    /// Remove the cache file.
    pub fn delete(&self) -> bool {
        if let Some(path) = self.file_path() {
            if path.exists() {
                return fs::remove_file(&path).is_ok();
            }
        }
        true // Already deleted or doesn't exist
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::TempDir;

    #[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
    struct TestData {
        name: String,
        count: i32,
    }

    /// Override cache_dir for tests to use a temp directory
    fn with_temp_cache_dir<F>(f: F)
    where
        F: FnOnce(PathBuf),
    {
        let temp_dir = TempDir::new().unwrap();
        let cache_path = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_path).unwrap();

        // Unfortunately, we can't easily override the global cache_dir function
        // in tests without introducing a trait or global state. For now, we'll
        // test the CacheStore logic by ensuring the directory exists.
        // In production, this uses $DATA_DIR.

        f(cache_path);
    }

    #[test]
    fn test_compute_fingerprint_is_stable() {
        let fp1 = compute_fingerprint();
        let fp2 = compute_fingerprint();
        assert_eq!(fp1, fp2, "Fingerprint should be stable across calls");
        assert!(!fp1.is_empty(), "Fingerprint should not be empty");
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        with_temp_cache_dir(|_cache_path| {
            let cache: CacheStore<TestData> = CacheStore::new("test-roundtrip");
            let data = TestData {
                name: "hello".to_string(),
                count: 42,
            };

            assert!(cache.save(&data), "save should succeed");

            let loaded = cache.load();
            assert!(loaded.is_some(), "load should return Some");
            assert_eq!(loaded.unwrap(), data, "loaded data should match saved data");
        });
    }

    #[test]
    fn test_load_nonexistent_returns_none() {
        with_temp_cache_dir(|_cache_path| {
            let cache: CacheStore<TestData> = CacheStore::new("nonexistent");
            assert_eq!(
                cache.load(),
                None,
                "load should return None for missing file"
            );
        });
    }

    #[test]
    fn test_delete_removes_file() {
        with_temp_cache_dir(|_cache_path| {
            let cache: CacheStore<TestData> = CacheStore::new("test-delete");
            let data = TestData {
                name: "delete-me".to_string(),
                count: 99,
            };

            cache.save(&data);
            assert!(cache.load().is_some(), "file should exist after save");

            assert!(cache.delete(), "delete should succeed");
            assert_eq!(cache.load(), None, "load should return None after delete");
        });
    }

    #[test]
    fn test_multiple_saves_overwrite() {
        with_temp_cache_dir(|_cache_path| {
            let cache: CacheStore<TestData> = CacheStore::new("test-overwrite");

            let data1 = TestData {
                name: "first".to_string(),
                count: 1,
            };
            cache.save(&data1);

            let data2 = TestData {
                name: "second".to_string(),
                count: 2,
            };
            cache.save(&data2);

            let loaded = cache.load().unwrap();
            assert_eq!(loaded, data2, "second save should overwrite first");
        });
    }

    #[test]
    fn test_handles_complex_types() {
        with_temp_cache_dir(|_cache_path| {
            #[derive(Serialize, Deserialize, Debug, PartialEq)]
            struct Complex {
                nested: Vec<TestData>,
                optional: Option<String>,
            }

            let cache: CacheStore<Complex> = CacheStore::new("test-complex");
            let data = Complex {
                nested: vec![
                    TestData {
                        name: "a".to_string(),
                        count: 1,
                    },
                    TestData {
                        name: "b".to_string(),
                        count: 2,
                    },
                ],
                optional: Some("value".to_string()),
            };

            cache.save(&data);
            let loaded = cache.load().unwrap();
            assert_eq!(loaded, data);
        });
    }
}
