use super::{HistoryRecord, HistoryRow, HistoryScope};
use rusqlite::{params, Connection};
use std::path::PathBuf;

pub struct HistoryDb {
    conn: Connection,
}

fn db_path() -> Result<PathBuf, String> {
    let dir = dirs_next::data_dir()
        .ok_or_else(|| "no data dir".to_string())?
        .join("TermGrid");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("history.sqlite"))
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pane_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    shell TEXT,
    cwd TEXT,
    cmd TEXT NOT NULL,
    exit_code INTEGER,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER,
    source TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_commands_pane_started ON commands(pane_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_session_started ON commands(session_id, started_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
    cmd, cwd, content='commands', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS commands_ai AFTER INSERT ON commands BEGIN
    INSERT INTO commands_fts(rowid, cmd, cwd) VALUES (new.id, new.cmd, COALESCE(new.cwd,''));
END;
CREATE TRIGGER IF NOT EXISTS commands_ad AFTER DELETE ON commands BEGIN
    INSERT INTO commands_fts(commands_fts, rowid, cmd, cwd) VALUES('delete', old.id, old.cmd, COALESCE(old.cwd,''));
END;
CREATE TRIGGER IF NOT EXISTS commands_au AFTER UPDATE ON commands BEGIN
    INSERT INTO commands_fts(commands_fts, rowid, cmd, cwd) VALUES('delete', old.id, old.cmd, COALESCE(old.cwd,''));
    INSERT INTO commands_fts(rowid, cmd, cwd) VALUES (new.id, new.cmd, COALESCE(new.cwd,''));
END;
"#;

impl HistoryDb {
    pub fn open() -> Result<Self, String> {
        let path = db_path()?;
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    pub fn insert(&mut self, row: &HistoryRow) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO commands(pane_id, session_id, shell, cwd, cmd, exit_code, started_at, duration_ms, source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    row.pane_id, row.session_id, row.shell, row.cwd, row.cmd,
                    row.exit_code, row.started_at, row.duration_ms, row.source
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn recent(&self, pane_id: &str, limit: u32) -> Result<Vec<HistoryRecord>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, pane_id, session_id, shell, cwd, cmd, exit_code, started_at, duration_ms, source
             FROM commands WHERE pane_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![pane_id, limit], map_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn search(&self, scope: HistoryScope, query: &str, limit: u32) -> Result<Vec<HistoryRecord>, String> {
        let q = query.trim();
        let scope_arg: Option<String> = match &scope {
            HistoryScope::Global => None,
            HistoryScope::Pane { pane_id } => Some(pane_id.clone()),
            HistoryScope::Session { session_id } => Some(session_id.clone()),
        };
        let scope_col: Option<&'static str> = match &scope {
            HistoryScope::Global => None,
            HistoryScope::Pane { .. } => Some("pane_id"),
            HistoryScope::Session { .. } => Some("session_id"),
        };

        if q.is_empty() {
            // No FTS — just recent rows in scope
            let (sql, rows) = match (scope_col, scope_arg) {
                (Some(col), Some(arg)) => {
                    let sql = format!(
                        "SELECT id, pane_id, session_id, shell, cwd, cmd, exit_code, started_at, duration_ms, source
                         FROM commands WHERE {} = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2", col);
                    let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map(params![arg, limit], map_row).map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
                    (sql, rows)
                }
                _ => {
                    let sql = "SELECT id, pane_id, session_id, shell, cwd, cmd, exit_code, started_at, duration_ms, source
                               FROM commands ORDER BY started_at DESC, id DESC LIMIT ?1".to_string();
                    let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map(params![limit], map_row).map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
                    (sql, rows)
                }
            };
            let _ = sql;
            return Ok(rows);
        }

        let fts_query = sanitize_fts(q);
        if fts_query.is_empty() {
            return Ok(vec![]);
        }

        match (scope_col, scope_arg) {
            (Some(col), Some(arg)) => {
                let sql = format!(
                    "SELECT c.id, c.pane_id, c.session_id, c.shell, c.cwd, c.cmd, c.exit_code, c.started_at, c.duration_ms, c.source
                     FROM commands c JOIN commands_fts f ON f.rowid = c.id
                     WHERE f.commands_fts MATCH ?1 AND c.{} = ?2
                     ORDER BY c.started_at DESC, c.id DESC LIMIT ?3", col);
                let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
                let rows: Vec<HistoryRecord> = stmt
                    .query_map(params![fts_query, arg, limit], map_row)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                Ok(rows)
            }
            _ => {
                let sql = "SELECT c.id, c.pane_id, c.session_id, c.shell, c.cwd, c.cmd, c.exit_code, c.started_at, c.duration_ms, c.source
                           FROM commands c JOIN commands_fts f ON f.rowid = c.id
                           WHERE f.commands_fts MATCH ?1
                           ORDER BY c.started_at DESC, c.id DESC LIMIT ?2";
                let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
                let rows: Vec<HistoryRecord> = stmt
                    .query_map(params![fts_query, limit], map_row)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                Ok(rows)
            }
        }
    }
}

fn sanitize_fts(q: &str) -> String {
    // Quote each token and join with AND-implicit space. Avoids FTS5 syntax errors.
    q.split_whitespace()
        .map(|tok| {
            let cleaned: String = tok.chars().filter(|c| c.is_alphanumeric() || *c == '/' || *c == '-' || *c == '_' || *c == '.').collect();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("\"{}\"", cleaned)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRecord> {
    Ok(HistoryRecord {
        id: row.get(0)?,
        row: HistoryRow {
            pane_id: row.get(1)?,
            session_id: row.get(2)?,
            shell: row.get(3)?,
            cwd: row.get(4)?,
            cmd: row.get(5)?,
            exit_code: row.get(6)?,
            started_at: row.get(7)?,
            duration_ms: row.get(8)?,
            source: row.get(9)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(pane: &str, cmd: &str) -> HistoryRow {
        HistoryRow {
            pane_id: pane.into(),
            session_id: "sess-1".into(),
            shell: Some("zsh".into()),
            cwd: Some("/tmp".into()),
            cmd: cmd.into(),
            exit_code: Some(0),
            started_at: 1_700_000_000_000,
            duration_ms: Some(50),
            source: "local".into(),
        }
    }

    #[test]
    fn insert_and_recent() {
        let mut db = HistoryDb::open_in_memory().unwrap();
        db.insert(&sample_row("p1", "ls")).unwrap();
        db.insert(&sample_row("p1", "git status")).unwrap();
        db.insert(&sample_row("p2", "echo hi")).unwrap();
        let r = db.recent("p1", 10).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].row.cmd, "git status"); // DESC by started_at, but same ts → insert order desc
    }

    #[test]
    fn fts_search_global_and_scoped() {
        let mut db = HistoryDb::open_in_memory().unwrap();
        db.insert(&sample_row("p1", "git status")).unwrap();
        db.insert(&sample_row("p1", "git commit -am wip")).unwrap();
        db.insert(&sample_row("p2", "ls -la")).unwrap();

        let global = db.search(HistoryScope::Global, "git", 10).unwrap();
        assert_eq!(global.len(), 2);

        let scoped = db.search(HistoryScope::Pane { pane_id: "p2".into() }, "ls", 10).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].row.cmd, "ls -la");

        let cross = db.search(HistoryScope::Pane { pane_id: "p2".into() }, "git", 10).unwrap();
        assert_eq!(cross.len(), 0);
    }

    #[test]
    fn empty_query_returns_recent_in_scope() {
        let mut db = HistoryDb::open_in_memory().unwrap();
        db.insert(&sample_row("p1", "first")).unwrap();
        db.insert(&sample_row("p2", "second")).unwrap();
        let r = db.search(HistoryScope::Global, "", 10).unwrap();
        assert_eq!(r.len(), 2);
    }
}
