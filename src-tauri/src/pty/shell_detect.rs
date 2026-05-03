use super::traits::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub struct SystemShellDetector;

impl SystemShellDetector {
    pub fn new() -> Self {
        Self
    }

    fn classify(path: &str) -> (String, ShellKind) {
        let lower = path.to_lowercase();
        let stem = Path::new(path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if lower.contains("git") && stem == "bash" {
            return ("Git Bash".into(), ShellKind::GitBash);
        }
        match stem.as_str() {
            "bash" => ("Bash".into(), ShellKind::Bash),
            "zsh" => ("Zsh".into(), ShellKind::Zsh),
            "fish" => ("Fish".into(), ShellKind::Fish),
            "nu" | "nushell" => ("Nushell".into(), ShellKind::Nushell),
            "pwsh" => ("PowerShell 7".into(), ShellKind::PowerShell),
            "powershell" => ("Windows PowerShell".into(), ShellKind::PowerShell),
            "cmd" => ("Command Prompt".into(), ShellKind::Cmd),
            "wsl" => ("WSL".into(), ShellKind::Other),
            "tcsh" => ("Tcsh".into(), ShellKind::Other),
            "csh" => ("Csh".into(), ShellKind::Other),
            "ksh" => ("Ksh".into(), ShellKind::Other),
            "dash" => ("Dash".into(), ShellKind::Other),
            "ash" => ("Ash".into(), ShellKind::Other),
            "elvish" => ("Elvish".into(), ShellKind::Other),
            "xonsh" => ("Xonsh".into(), ShellKind::Other),
            "ion" => ("Ion".into(), ShellKind::Other),
            "osh" | "oil" => ("Oil".into(), ShellKind::Other),
            "sh" => ("Sh".into(), ShellKind::Other),
            other if !other.is_empty() => (
                other[..1].to_uppercase() + &other[1..],
                ShellKind::Other,
            ),
            _ => ("Shell".into(), ShellKind::Other),
        }
    }

    fn add(shells: &mut Vec<ShellInfo>, seen: &mut HashSet<String>, path: &str) {
        if path.is_empty() { return; }
        let canon = std::fs::canonicalize(path)
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
            .unwrap_or_else(|| path.to_string());
        if !seen.insert(canon.clone()) { return; }
        let (name, kind) = Self::classify(path);
        shells.push(ShellInfo { name, path: path.to_string(), kind });
    }

    /// Walk every directory in PATH, looking for any of `binaries`.
    fn from_path(binaries: &[&str]) -> Vec<String> {
        let mut found = Vec::new();
        let path_var = std::env::var_os("PATH").unwrap_or_default();
        for dir in std::env::split_paths(&path_var) {
            for bin in binaries {
                let candidate = dir.join(bin);
                if candidate.is_file() && is_executable(&candidate) {
                    if let Some(s) = candidate.to_str() {
                        found.push(s.to_string());
                    }
                }
            }
        }
        found
    }

    #[cfg(unix)]
    fn detect_shells() -> Vec<ShellInfo> {
        let mut shells = Vec::new();
        let mut seen = HashSet::new();

        // 1) The user's actual login shell (if SHELL is set & file exists) — first priority.
        if let Ok(s) = std::env::var("SHELL") {
            if Path::new(&s).exists() {
                Self::add(&mut shells, &mut seen, &s);
            }
        }

        // 2) Whatever /etc/shells declares — the canonical system list.
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if Path::new(line).exists() {
                    Self::add(&mut shells, &mut seen, line);
                }
            }
        }

        // 3) Walk PATH for known shells we might have missed (homebrew, scoop, etc.).
        let bins = ["zsh", "bash", "fish", "nu", "elvish", "xonsh", "ion", "tcsh", "ksh", "dash", "osh", "pwsh"];
        for p in Self::from_path(&bins) {
            Self::add(&mut shells, &mut seen, &p);
        }

        // 4) Backstop — well-known absolute paths on macOS / Linux.
        let backstops = [
            "/bin/zsh", "/bin/bash", "/bin/sh", "/bin/dash",
            "/usr/bin/zsh", "/usr/bin/bash", "/usr/bin/fish", "/usr/bin/nu",
            "/usr/local/bin/zsh", "/usr/local/bin/bash", "/usr/local/bin/fish", "/usr/local/bin/nu",
            "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/bash", "/opt/homebrew/bin/fish", "/opt/homebrew/bin/nu",
        ];
        for p in backstops {
            if Path::new(p).exists() {
                Self::add(&mut shells, &mut seen, p);
            }
        }

        shells
    }

    #[cfg(windows)]
    fn detect_shells() -> Vec<ShellInfo> {
        let mut shells = Vec::new();
        let mut seen = HashSet::new();

        // 1) PowerShell 7 (pwsh) anywhere in PATH
        for p in Self::from_path(&["pwsh.exe"]) {
            Self::add(&mut shells, &mut seen, &p);
        }

        // 2) Windows PowerShell 5.1 — fixed system path
        let ps_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        if Path::new(ps_path).exists() {
            Self::add(&mut shells, &mut seen, ps_path);
        }

        // 3) CMD
        let cmd_path = r"C:\Windows\System32\cmd.exe";
        if Path::new(cmd_path).exists() {
            Self::add(&mut shells, &mut seen, cmd_path);
        }

        // 4) Git Bash — multiple known install paths
        let git_paths = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
        ];
        for p in git_paths {
            if Path::new(p).exists() {
                Self::add(&mut shells, &mut seen, p);
                break;
            }
        }

        // 5) Nushell, Elvish, etc. installed via Scoop / Chocolatey — search PATH
        for p in Self::from_path(&["nu.exe", "elvish.exe", "xonsh.exe"]) {
            Self::add(&mut shells, &mut seen, &p);
        }

        // 6) WSL — list distros via `wsl.exe -l -q` (UTF-16LE output, hence the dance).
        if let Ok(output) = std::process::Command::new("wsl.exe").args(["-l", "-q"]).output() {
            if output.status.success() {
                let bytes = output.stdout;
                // wsl.exe emits UTF-16LE; decode best-effort.
                let utf16: Vec<u16> = bytes.chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&utf16);
                for distro in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                    let path = "wsl.exe".to_string();
                    let name = format!("WSL: {}", distro);
                    if seen.insert(format!("wsl::{}", distro)) {
                        shells.push(ShellInfo { name, path, kind: ShellKind::Other });
                    }
                }
            }
        }

        shells
    }

    #[cfg(unix)]
    fn pick_default(shells: &[ShellInfo]) -> ShellInfo {
        // Prefer $SHELL if present in the detected list, else first detected, else /bin/sh.
        if let Ok(env_shell) = std::env::var("SHELL") {
            if let Some(s) = shells.iter().find(|s| s.path == env_shell) {
                return s.clone();
            }
        }
        shells.first().cloned().unwrap_or(ShellInfo {
            name: "Sh".into(),
            path: "/bin/sh".into(),
            kind: ShellKind::Other,
        })
    }

    #[cfg(windows)]
    fn pick_default(shells: &[ShellInfo]) -> ShellInfo {
        // Prefer pwsh > Windows PowerShell > CMD > whatever's first.
        for kind_pref in [ShellKind::PowerShell, ShellKind::Cmd, ShellKind::GitBash] {
            if let Some(s) = shells.iter().find(|s| s.kind == kind_pref) {
                return s.clone();
            }
        }
        shells.first().cloned().unwrap_or(ShellInfo {
            name: "PowerShell".into(),
            path: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
            kind: ShellKind::PowerShell,
        })
    }
}

#[cfg(unix)]
fn is_executable(path: &PathBuf) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(_path: &PathBuf) -> bool {
    // On Windows, PATHEXT determines executability; we already filtered by .exe.
    true
}

impl ShellDetector for SystemShellDetector {
    fn available_shells(&self) -> Vec<ShellInfo> {
        Self::detect_shells()
    }

    fn default_shell(&self) -> ShellInfo {
        Self::pick_default(&Self::detect_shells())
    }
}
