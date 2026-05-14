//! **v5:** Install TermGrid shell plugins to the user's home directory.

use serde::Serialize;
use std::fs;

const ZSH_PLUGIN: &str = include_str!("../../../shell-plugins/termgrid.zsh");
const BASH_PLUGIN: &str = include_str!("../../../shell-plugins/termgrid.bash");
const FISH_PLUGIN: &str = include_str!("../../../shell-plugins/termgrid.fish");
const README: &str = include_str!("../../../shell-plugins/README.md");

#[derive(Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub plugins_dir: String,
    pub instructions: String,
}

/// Installs the shell plugins to `~/.termgrid/plugins/`. Returns paths and
/// installation instructions for the user.
pub fn install_plugins() -> Result<InstallResult, String> {
    let home = dirs_next::home_dir().ok_or("Could not determine home directory")?;
    let plugins_dir = home.join(".termgrid").join("plugins");
    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create plugin directory: {}", e))?;

    // Write each plugin file
    fs::write(plugins_dir.join("termgrid.zsh"), ZSH_PLUGIN)
        .map_err(|e| format!("Failed to write zsh plugin: {}", e))?;
    fs::write(plugins_dir.join("termgrid.bash"), BASH_PLUGIN)
        .map_err(|e| format!("Failed to write bash plugin: {}", e))?;
    fs::write(plugins_dir.join("termgrid.fish"), FISH_PLUGIN)
        .map_err(|e| format!("Failed to write fish plugin: {}", e))?;
    fs::write(plugins_dir.join("README.md"), README)
        .map_err(|e| format!("Failed to write README: {}", e))?;

    let instructions = format!(
        r#"Shell plugins installed to: {}

To enable:

Zsh:    Add to ~/.zshrc:
        source {}/termgrid.zsh

Bash:   Add to ~/.bashrc:
        source {}/termgrid.bash

Fish:   Add to ~/.config/fish/config.fish:
        source {}/termgrid.fish

After sourcing, restart your shell or run `source ~/.zshrc` (or .bashrc, etc.).

For more details, see: {}/README.md"#,
        plugins_dir.display(),
        plugins_dir.display(),
        plugins_dir.display(),
        plugins_dir.display(),
        plugins_dir.display()
    );

    Ok(InstallResult {
        success: true,
        plugins_dir: plugins_dir.to_string_lossy().to_string(),
        instructions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Serialize tests that mutate HOME
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn installs_all_plugin_files() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let result = install_plugins().unwrap();
        assert!(result.success);
        assert!(tmp.path().join(".termgrid/plugins/termgrid.zsh").exists());
        assert!(tmp.path().join(".termgrid/plugins/termgrid.bash").exists());
        assert!(tmp.path().join(".termgrid/plugins/termgrid.fish").exists());
        assert!(tmp.path().join(".termgrid/plugins/README.md").exists());
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }

    #[test]
    fn returns_instructions() {
        let _lock = HOME_LOCK.lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        let result = install_plugins().unwrap();
        assert!(result.instructions.contains("source"));
        assert!(result.instructions.contains("termgrid.zsh"));
        assert!(result.instructions.contains("~/.zshrc"));
        // Restore original HOME
        if let Some(h) = original_home {
            std::env::set_var("HOME", h);
        }
    }
}
