pub mod adoption;
pub mod cache;
pub mod commands;
pub mod config;
pub mod history;
pub mod history_commands;
pub mod pty;
pub mod snapshot;
pub mod state;
pub mod window_geometry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = state::AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_shells_with_default,
            commands::list_shells,
            commands::default_shell,
            commands::create_pane,
            commands::write_pane,
            commands::resize_pane,
            commands::close_pane,
            commands::pane_remote_context,
            snapshot::snapshot_save,
            snapshot::snapshot_load,
            snapshot::snapshot_delete,
            snapshot::snapshot_list,
            history_commands::history_record,
            history_commands::history_search,
            history_commands::history_recent,
            adoption::commands::list_adoptable_sessions_cmd,
            adoption::commands::snapshot_session_cmd,
            adoption::commands::frontmost_terminal_app_cmd,
            adoption::commands::snap_to_frontmost_cmd,
            adoption::commands::replay_env_in_cwd_cmd,
            adoption::commands::clipboard_capture_cmd,
            adoption::commands::install_shell_plugins_cmd,
        ])
        .setup(|app| {
            // Apply cached window geometry before showing the window
            window_geometry::apply_cached_geometry(app.handle(), "main");

            // Start tracking geometry changes
            window_geometry::start_geometry_tracking(app.handle().clone(), "main".to_string());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
