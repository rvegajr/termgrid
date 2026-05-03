pub mod db;

use db::HistoryDb;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct HistoryRow {
    pub pane_id: String,
    pub session_id: String,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cmd: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub duration_ms: Option<i64>,
    pub source: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct HistoryRecord {
    pub id: i64,
    #[serde(flatten)]
    pub row: HistoryRow,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HistoryScope {
    Global,
    Pane { pane_id: String },
    Session { session_id: String },
}

pub struct HistoryState {
    db: Mutex<HistoryDb>,
}

impl HistoryState {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            db: Mutex::new(HistoryDb::open()?),
        })
    }

    pub fn record(&self, row: HistoryRow) -> Result<i64, String> {
        self.db.lock().map_err(|e| e.to_string())?.insert(&row)
    }

    pub fn search(
        &self,
        scope: HistoryScope,
        query: &str,
        limit: u32,
    ) -> Result<Vec<HistoryRecord>, String> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .search(scope, query, limit)
    }

    pub fn recent(&self, pane_id: &str, limit: u32) -> Result<Vec<HistoryRecord>, String> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .recent(pane_id, limit)
    }
}
