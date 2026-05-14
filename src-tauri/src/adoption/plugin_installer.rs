//! **v5:** Install TermGrid shell plugins to the user's home directory.

use serde::Serialize;
use std::fs;
use std::path::Path;

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

/// Public entry — installs to the current user's home directory.
pub fn install_plugins() -> Result<InstallResult, String> {
    let home = dirs_next::home_dir().ok_or("Could not determine home directory")?;
    install_plugins_to(&home)
}

/// Installs the shell plugins under `<home>/.termgrid/plugins/`. Parameterized
/// on the home directory so unit tests can use a temp path without mutating
/// the global `$HOME` env var (which would race other tests in the same
/// process — every `dirs_next::home_dir()` caller would see the temp path
/// disappear when the TempDir drops).
pub fn install_plugins_to(home: &Path) -> Result<InstallResult, String> {
    let plugins_dir = home.join(".termgrid").join("plugins");
    fs::create_dir_all(&plugins_dir)
        .map_err(|e| format!("Failed to create plugin directory: {}", e))?;

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
    use tempfile::TempDir;

    #[test]
    fn installs_all_plugin_files() {
        let tmp = TempDir::new().unwrap();
        let result = install_plugins_to(tmp.path()).unwrap();
        assert!(result.success);
        assert!(tmp.path().join(".termgrid/plugins/termgrid.zsh").exists());
        assert!(tmp.path().join(".termgrid/plugins/termgrid.bash").exists());
        assert!(tmp.path().join(".termgrid/plugins/termgrid.fish").exists());
        assert!(tmp.path().join(".termgrid/plugins/README.md").exists());
    }

    #[test]
    fn returns_instructions() {
        let tmp = TempDir::new().unwrap();
        let result = install_plugins_to(tmp.path()).unwrap();
        assert!(result.instructions.contains("source"));
        assert!(result.instructions.contains("termgrid.zsh"));
        assert!(result.instructions.contains("~/.zshrc"));
    }
}
