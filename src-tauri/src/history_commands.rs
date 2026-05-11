use crate::history::{HistoryRecord, HistoryRow, HistoryScope};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn history_record(state: State<AppState>, row: HistoryRow) -> Result<i64, String> {
    state.get_history().record(row)
}

#[tauri::command]
pub fn history_search(
    state: State<AppState>,
    scope: HistoryScope,
    query: String,
    limit: u32,
) -> Result<Vec<HistoryRecord>, String> {
    state.get_history().search(scope, &query, limit)
}

#[tauri::command]
pub fn history_recent(
    state: State<AppState>,
    pane_id: String,
    limit: u32,
) -> Result<Vec<HistoryRecord>, String> {
    state.get_history().recent(&pane_id, limit)
}
