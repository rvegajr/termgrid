use super::manager::PtyManager;
use super::shell_detect::SystemShellDetector;
use super::traits::*;
use std::path::Path;

// ============================================================
// Shell Detection Tests
// ============================================================

#[test]
fn test_detects_at_least_one_shell() {
    let detector = SystemShellDetector::new();
    let shells = detector.available_shells();
    assert!(!shells.is_empty(), "Should detect at least one shell");
}

#[test]
fn test_default_shell_exists_on_disk() {
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    assert!(
        Path::new(&shell.path).exists(),
        "Default shell '{}' should exist at '{}'",
        shell.name,
        shell.path
    );
}

#[test]
fn test_shell_kind_detected_correctly() {
    let detector = SystemShellDetector::new();
    for shell in detector.available_shells() {
        match shell.kind {
            ShellKind::Bash => assert!(shell.path.contains("bash")),
            ShellKind::Zsh => assert!(shell.path.contains("zsh")),
            ShellKind::Fish => assert!(shell.path.contains("fish")),
            ShellKind::PowerShell => {
                assert!(shell.path.contains("powershell") || shell.path.contains("pwsh"))
            }
            ShellKind::Cmd => assert!(shell.path.contains("cmd")),
            ShellKind::GitBash => assert!(shell.path.contains("bash")),
            ShellKind::Nushell => assert!(shell.path.contains("nu")),
            ShellKind::Other => {}
        }
    }
}

#[cfg(unix)]
#[test]
fn test_unix_detects_zsh_or_bash() {
    let detector = SystemShellDetector::new();
    let shells = detector.available_shells();
    let has_common = shells
        .iter()
        .any(|s| s.kind == ShellKind::Zsh || s.kind == ShellKind::Bash);
    assert!(has_common, "Unix should detect zsh or bash");
}

#[cfg(windows)]
#[test]
fn test_windows_detects_powershell() {
    let detector = SystemShellDetector::new();
    let shells = detector.available_shells();
    let has_ps = shells.iter().any(|s| s.kind == ShellKind::PowerShell);
    assert!(has_ps, "Windows should detect PowerShell");
}

// ============================================================
// PTY Manager Tests
// ============================================================

#[test]
fn test_spawn_creates_process() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();

    let result = manager.spawn(
        &"test-pane-1".to_string(),
        &shell.path,
        &std::env::current_dir().unwrap().to_string_lossy(),
        80,
        24,
    );
    assert!(result.is_ok(), "Spawn should succeed: {:?}", result.err());

    // Cleanup
    manager.kill(&"test-pane-1".to_string()).ok();
}

#[test]
fn test_spawn_nonexistent_shell_returns_error() {
    let manager = PtyManager::new();
    let result = manager.spawn(
        &"test-pane-bad".to_string(),
        "/usr/bin/nonexistent-shell-xyz",
        "/tmp",
        80,
        24,
    );
    assert!(result.is_err(), "Spawn with bad shell should fail");
}

#[test]
fn test_list_active_shows_spawned_panes() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"pane-a".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();
    manager
        .spawn(&"pane-b".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();

    let active = manager.list_active();
    assert!(active.contains(&"pane-a".to_string()));
    assert!(active.contains(&"pane-b".to_string()));

    manager.kill(&"pane-a".to_string()).ok();
    manager.kill(&"pane-b".to_string()).ok();
}

#[test]
fn test_killed_pane_removed_from_active() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"pane-kill".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();
    assert!(manager.is_alive(&"pane-kill".to_string()));

    manager.kill(&"pane-kill".to_string()).unwrap();
    assert!(!manager.is_alive(&"pane-kill".to_string()));
    assert!(!manager.list_active().contains(&"pane-kill".to_string()));
}

#[test]
fn test_write_to_nonexistent_pane_returns_error() {
    let manager = PtyManager::new();
    let result = manager.write(&"nonexistent".to_string(), b"hello");
    assert!(matches!(result, Err(PtyError::PaneNotFound(_))));
}

#[test]
fn test_kill_nonexistent_pane_returns_error() {
    let manager = PtyManager::new();
    let result = manager.kill(&"nonexistent".to_string());
    assert!(matches!(result, Err(PtyError::PaneNotFound(_))));
}

#[test]
fn test_duplicate_pane_id_returns_error() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"dup-pane".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();
    let result = manager.spawn(&"dup-pane".to_string(), &shell.path, &cwd, 80, 24);
    assert!(matches!(result, Err(PtyError::PaneAlreadyExists(_))));

    manager.kill(&"dup-pane".to_string()).ok();
}

#[test]
fn test_write_sends_data_to_pty() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"write-test".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();

    // Should not error
    let result = manager.write(&"write-test".to_string(), b"echo hello\n");
    assert!(result.is_ok());

    manager.kill(&"write-test".to_string()).ok();
}

#[test]
fn test_resize_changes_dimensions() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"resize-test".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();

    let result = manager.resize(&"resize-test".to_string(), 120, 40);
    assert!(result.is_ok(), "Resize should succeed");

    manager.kill(&"resize-test".to_string()).ok();
}

#[test]
fn test_read_receives_output() {
    let manager = PtyManager::new();
    let detector = SystemShellDetector::new();
    let shell = detector.default_shell();
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    manager
        .spawn(&"read-test".to_string(), &shell.path, &cwd, 80, 24)
        .unwrap();

    let rx = manager.subscribe(&"read-test".to_string()).unwrap();

    // The shell prompt itself should produce some output
    let data = rx.recv_timeout(std::time::Duration::from_secs(3));
    assert!(data.is_ok(), "Should receive output from shell");
    assert!(!data.unwrap().is_empty(), "Output should not be empty");

    manager.kill(&"read-test".to_string()).ok();
}
