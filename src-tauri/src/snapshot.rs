use std::fs;
use std::path::PathBuf;

fn snapshot_dir() -> Result<PathBuf, String> {
    let base = dirs_next::data_dir()
        .ok_or_else(|| "no data dir".to_string())?
        .join("TermGrid")
        .join("panes");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn safe_name(pane_id: &str) -> String {
    pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[tauri::command]
pub fn snapshot_save(pane_id: String, contents: String) -> Result<(), String> {
    let path = snapshot_dir()?.join(format!("{}.txt", safe_name(&pane_id)));
    fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snapshot_load(pane_id: String) -> Result<Option<String>, String> {
    let path = snapshot_dir()?.join(format!("{}.txt", safe_name(&pane_id)));
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snapshot_delete(pane_id: String) -> Result<(), String> {
    let path = snapshot_dir()?.join(format!("{}.txt", safe_name(&pane_id)));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn snapshot_list() -> Result<Vec<String>, String> {
    let dir = snapshot_dir()?;
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(name) = entry.path().file_stem().and_then(|s| s.to_str()) {
            out.push(name.to_string());
        }
    }
    Ok(out)
}
