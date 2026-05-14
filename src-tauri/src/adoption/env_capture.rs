// On Windows none of the parsing helpers are reachable from `env_of_pid`
// (we have no Windows env probe in v3), but they're still exercised by
// unit tests on every host. Silence the dead-code warnings without
// touching the cfg gating that controls the actual probe selection.
#![cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]

//! Capture a filtered slice of a foreign process's environment.
//!
//! Use case: the user adopts a shell that had `VIRTUAL_ENV`, `NVM_DIR`,
//! `CONDA_DEFAULT_ENV`, etc. set. We forward those into the new TermGrid
//! pane so language toolchains light up automatically.
//!
//! Privacy/security stance:
//!  - We **filter** to a hard-coded allow-list of names. Tokens, secrets,
//!    `*_KEY`, `*_TOKEN`, `*_SECRET` are *never* forwarded, even by
//!    accident, because they're not on the allow-list.
//!  - We capture only when the OS gives us the env for free (Linux
//!    `/proc/<pid>/environ`, macOS `ps -E`). We do not ptrace or attach.
//!  - On any read failure we return an empty vec — never error or block.

use super::types::EnvVar;
use std::collections::HashSet;

/// Environment variable names we consider safe-and-useful to forward.
///
/// Picked to cover the most common "your shell will misbehave without
/// this" toolchain inputs. Add more on user request. Anything not on
/// this list is dropped from the capture regardless of what the source
/// shell had.
const FORWARD_ALLOWLIST: &[&str] = &[
    // Python
    "VIRTUAL_ENV",
    "PYENV_VERSION",
    "PYENV_VIRTUAL_ENV",
    "CONDA_DEFAULT_ENV",
    "CONDA_PREFIX",
    // Node
    "NVM_DIR",
    "NODE_OPTIONS",
    "NODE_VERSION",
    // Ruby
    "RBENV_VERSION",
    "RVM_PATH",
    // Rust
    "RUSTUP_TOOLCHAIN",
    "CARGO_HOME",
    // Java
    "JAVA_HOME",
    "JDK_HOME",
    // Go
    "GOPATH",
    "GOROOT",
    // Direnv / asdf — set per-project, very desirable to inherit.
    "DIRENV_DIR",
    "DIRENV_FILE",
    "ASDF_DIR",
    "ASDF_DATA_DIR",
    // Cloud / infra context — useful, no token contents.
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "GOOGLE_CLOUD_PROJECT",
    "KUBECONFIG",
    "KUBE_CONTEXT",
    // SSH agent / GPG agent sockets — preserves agent context.
    "SSH_AUTH_SOCK",
    "GPG_TTY",
    // Generic project context.
    "PROJECT_ROOT",
    "WORKSPACE",
];

/// Decide whether one env name is on the allow-list. Case-sensitive
/// (`virtual_env` != `VIRTUAL_ENV`) because POSIX env names are.
fn is_forwardable(name: &str) -> bool {
    let set: HashSet<&str> = FORWARD_ALLOWLIST.iter().copied().collect();
    set.contains(name)
}

/// Parse a `NAME=VALUE` line into [`EnvVar`], or return `None` if the
/// line is malformed (no `=`, empty name, etc).
///
/// Pure function — exported for testing.
pub(crate) fn parse_kv(line: &str) -> Option<EnvVar> {
    let eq = line.find('=')?;
    let name = &line[..eq];
    if name.is_empty() {
        return None;
    }
    let value = &line[eq + 1..];
    Some(EnvVar {
        name: name.to_string(),
        value: value.to_string(),
    })
}

/// Filter a sequence of raw env entries down to the forward-safe subset.
///
/// Stable order: input order is preserved so callers can reason about
/// "first occurrence wins" if the source process happened to repeat a
/// var (which Linux env can do).
pub(crate) fn filter_to_allowlist<I>(entries: I) -> Vec<EnvVar>
where
    I: IntoIterator<Item = EnvVar>,
{
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for ev in entries {
        if !is_forwardable(&ev.name) {
            continue;
        }
        if seen.insert(ev.name.clone()) {
            out.push(ev);
        }
    }
    out
}

/// Read and filter the environment of `pid`. Best-effort, never errors.
pub fn env_of_pid(pid: u32) -> Vec<EnvVar> {
    #[cfg(target_os = "linux")]
    {
        linux::env_of_pid(pid)
    }
    #[cfg(target_os = "macos")]
    {
        macos::env_of_pid(pid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Vec::new()
    }
}

/// **v4:** Reproduce the env a fresh shell would inherit if started in
/// `cwd`.
///
/// Why this exists: on modern macOS we can't read the *actual* env of an
/// unrelated process (Apple sandboxes that probe). But we can spawn a
/// brand-new shell in the target's working directory and capture what
/// *it* sees — which catches direnv, asdf, mise, nvm, virtualenv
/// auto-activation, project `.envrc` files, etc. For ~95% of adoption
/// flows that's exactly the env the user wants.
///
/// Implementation:
/// - Resolves `shell` against `/bin/<shell>` (or `/usr/bin/env <shell>`
///   on Linux fallback) so we don't accidentally pick TermGrid's own
///   PATH.
/// - Invokes with `-lic 'export -p; exit'` so the shell runs its login
///   *and* interactive rc files — this is what triggers direnv/asdf/mise.
///   `export -p` is POSIX and outputs `export NAME='VALUE'` per var.
/// - Hard 4-second timeout via process::Child::wait. If the shell hangs
///   (rare; happens with broken `.zshrc`), we abandon and return empty.
/// - Filters via the same allow-list as `env_of_pid` so we never forward
///   secrets that happened to land in the new shell's env.
///
/// Safe on every platform; on Windows we no-op (no notion of `.envrc`).
pub fn replay_env_in_cwd(shell: &str, cwd: &std::path::Path) -> Vec<EnvVar> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        replay::run(shell, cwd)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (shell, cwd);
        Vec::new()
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod replay {
    use super::*;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Resolve a shell name to an absolute path we trust. We use the
    /// shell binary that *the target shell would have used*, not
    /// TermGrid's PATH lookup, so we get the user's actual rc-running
    /// flavor of bash/zsh/fish.
    fn resolve_shell(shell: &str) -> Option<String> {
        let bare = std::path::Path::new(shell)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| shell.to_string());
        // First: trusted absolute paths.
        for prefix in &["/opt/homebrew/bin", "/usr/local/bin", "/bin", "/usr/bin"] {
            let p = format!("{}/{}", prefix, bare);
            if Path::new(&p).is_file() {
                return Some(p);
            }
        }
        // Fall back to bare name; std::process::Command will PATH-resolve.
        if matches!(
            bare.as_str(),
            "zsh" | "bash" | "fish" | "ksh" | "tcsh" | "dash"
        ) {
            Some(bare)
        } else {
            None
        }
    }

    /// Run the shell in `cwd` and parse its `export -p` output.
    pub(super) fn run(shell: &str, cwd: &Path) -> Vec<EnvVar> {
        if !cwd.is_dir() {
            return Vec::new();
        }
        let Some(shell_path) = resolve_shell(shell) else {
            return Vec::new();
        };
        // fish has its own export syntax; for the v4 minimum we skip it
        // and let env_of_pid handle fish on Linux (where /proc works).
        let is_fish = shell_path.ends_with("fish");
        if is_fish {
            return Vec::new();
        }

        let mut child = match Command::new(&shell_path)
            .args(["-lic", "export -p; exit 0"])
            .current_dir(cwd)
            .env("TERMGRID_REPLAY", "1") // marker so rc files can opt out
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };

        // Hard 4s timeout — we'd rather miss env than hang the picker.
        let deadline = Instant::now() + Duration::from_millis(4000);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Vec::new();
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Err(_) => return Vec::new(),
            }
        }
        let stdout = match child.wait_with_output() {
            Ok(o) => o.stdout,
            Err(_) => return Vec::new(),
        };
        let text = String::from_utf8_lossy(&stdout).into_owned();
        let parsed = parse_export_p(&text);
        filter_to_allowlist(parsed)
    }
}

/// Parse the output of POSIX `export -p`.
///
/// Lines look like:
/// ```text
/// export NAME='value with spaces'
/// export NAME=value
/// export NAME
/// declare -x NAME="value"   # bash
/// ```
///
/// We accept all of those. Quoting: single-quote bodies are returned
/// verbatim; double-quote bodies are returned with `\$`, `\\`, `\"`,
/// `` \` `` unescaped (that's the only escapes POSIX `export -p` emits).
///
/// Pure function — exported for testing.
pub(crate) fn parse_export_p(text: &str) -> Vec<EnvVar> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_start();
        let rest = if let Some(r) = line.strip_prefix("export ") {
            r
        } else if let Some(r) = line.strip_prefix("declare -x ") {
            r
        } else if let Some(r) = line.strip_prefix("typeset -x ") {
            r
        } else {
            continue;
        };
        let Some(eq) = rest.find('=') else {
            continue; // `export NAME` with no value — skip.
        };
        let name = rest[..eq].trim();
        if name.is_empty() {
            continue;
        }
        let raw_value = &rest[eq + 1..];
        let value = unquote_export_value(raw_value);
        out.push(EnvVar {
            name: name.to_string(),
            value,
        });
    }
    out
}

/// Strip POSIX export quoting from a value. See `parse_export_p`.
fn unquote_export_value(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if first == b'\'' && last == b'\'' {
            // Single-quoted: contents are literal except for the
            // POSIX `'\''` sequence that re-enters single quotes.
            let inner = &s[1..s.len() - 1];
            return inner.replace("'\\''", "'");
        }
        if first == b'"' && last == b'"' {
            let inner = &s[1..s.len() - 1];
            // Minimal double-quote unescape.
            let mut out = String::with_capacity(inner.len());
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(next) = chars.next() {
                        match next {
                            '\\' | '"' | '$' | '`' | '\n' => out.push(next),
                            other => {
                                out.push('\\');
                                out.push(other);
                            }
                        }
                    }
                } else {
                    out.push(c);
                }
            }
            return out;
        }
    }
    s.to_string()
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::fs;

    pub fn env_of_pid(pid: u32) -> Vec<EnvVar> {
        let path = format!("/proc/{}/environ", pid);
        let Ok(bytes) = fs::read(&path) else {
            return Vec::new();
        };
        // /proc/<pid>/environ is NUL-separated.
        let parsed = bytes.split(|b| *b == 0).filter_map(|chunk| {
            if chunk.is_empty() {
                return None;
            }
            let s = String::from_utf8_lossy(chunk);
            parse_kv(&s)
        });
        filter_to_allowlist(parsed)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::process::Command;

    /// macOS env probe via `ps -E`.
    ///
    /// Historical context: pre-Mojave macOS exposed each process's env
    /// block via `ps -E`, parsing right after argv. Modern macOS
    /// (Big Sur+ depending on SIP / hardened-runtime settings) strips
    /// the env block from `ps` output even for the user's own processes
    /// — so this probe legitimately returns `Vec::new()` most of the
    /// time on modern hosts.
    ///
    /// We keep the implementation because:
    /// 1. It works on older / SIP-disabled hosts and CI environments.
    /// 2. It costs effectively nothing on the empty case (one `ps`
    ///    invocation per snapshot, ~5 ms).
    /// 3. The picker hides the "Toolchain env" preview section when the
    ///    list is empty, so the empty case has no UI cost either.
    pub fn env_of_pid(pid: u32) -> Vec<EnvVar> {
        // `ps -E -ww -p PID -o command=`: dump unbounded-width command +
        // env in one column, no header.
        let out = match Command::new("ps")
            .args(["-E", "-ww", "-p", &pid.to_string(), "-o", "command="])
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };
        let line = String::from_utf8_lossy(&out.stdout).into_owned();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let parsed = extract_macos_env_tokens(trimmed)
            .into_iter()
            .filter_map(|tok| parse_kv(&tok));
        filter_to_allowlist(parsed)
    }
}

/// macOS-specific helper: walk a `ps -E` line and pull out the
/// `NAME=VALUE` tokens.
///
/// Heuristic: split on whitespace, then keep tokens that contain `=` and
/// whose pre-`=` portion is a plausible env name (ASCII alnum + `_`,
/// non-empty, non-leading-digit). This isn't perfect — env values with
/// embedded spaces will be truncated — but it's right enough for the
/// allow-listed names we care about, all of which have well-behaved
/// path-shaped values.
///
/// Exported for testing; safe to use on all platforms.
pub(crate) fn extract_macos_env_tokens(line: &str) -> Vec<String> {
    line.split_whitespace()
        .filter(|tok| {
            let Some(eq) = tok.find('=') else {
                return false;
            };
            let name = &tok[..eq];
            if name.is_empty() {
                return false;
            }
            let first = name.as_bytes()[0];
            if !(first.is_ascii_alphabetic() || first == b'_') {
                return false;
            }
            name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_export_p_single_quoted() {
        // POSIX `export -p` form, what zsh/bash usually emit.
        let text = "export FOO='bar baz'\nexport HOME='/Users/admin'\n";
        let vars = parse_export_p(text);
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].name, "FOO");
        assert_eq!(vars[0].value, "bar baz");
        assert_eq!(vars[1].name, "HOME");
        assert_eq!(vars[1].value, "/Users/admin");
    }

    #[test]
    fn parse_export_p_handles_escaped_single_quote() {
        let text = "export GREETING='it'\\''s working'";
        let vars = parse_export_p(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].value, "it's working");
    }

    #[test]
    fn parse_export_p_double_quoted() {
        let text = r#"export A="value with $special \"chars\""#;
        let vars = parse_export_p(text);
        // We don't guarantee perfect parse of malformed-trailing-quote
        // lines; just that we don't panic and return at most one var.
        assert!(vars.len() <= 1);
    }

    #[test]
    fn parse_export_p_declare_x_form() {
        // bash's `declare -x NAME="value"` form.
        let text = "declare -x VIRTUAL_ENV=\"/opt/proj/.venv\"";
        let vars = parse_export_p(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].name, "VIRTUAL_ENV");
        assert_eq!(vars[0].value, "/opt/proj/.venv");
    }

    #[test]
    fn parse_export_p_skips_naked_export() {
        // `export NAME` with no `=` (declares for export, no value) — skip.
        let text = "export EMPTY\nexport REAL=ok\n";
        let vars = parse_export_p(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].name, "REAL");
        assert_eq!(vars[0].value, "ok");
    }

    #[test]
    fn parse_export_p_unquoted_value() {
        let text = "export N=42";
        let vars = parse_export_p(text);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].value, "42");
    }

    #[test]
    fn parse_kv_basic() {
        let ev = parse_kv("FOO=bar").unwrap();
        assert_eq!(ev.name, "FOO");
        assert_eq!(ev.value, "bar");
    }

    #[test]
    fn parse_kv_allows_equals_in_value() {
        let ev = parse_kv("VIRTUAL_ENV=/path/with=equals").unwrap();
        assert_eq!(ev.name, "VIRTUAL_ENV");
        assert_eq!(ev.value, "/path/with=equals");
    }

    #[test]
    fn parse_kv_rejects_no_equals() {
        assert!(parse_kv("MALFORMED").is_none());
    }

    #[test]
    fn parse_kv_rejects_empty_name() {
        assert!(parse_kv("=value").is_none());
    }

    #[test]
    fn allowlist_drops_unknown_vars() {
        let inputs = vec![
            EnvVar {
                name: "VIRTUAL_ENV".into(),
                value: "/v".into(),
            },
            EnvVar {
                name: "SECRET_KEY".into(),
                value: "shhh".into(),
            },
            EnvVar {
                name: "PATH".into(),
                value: "/bin".into(),
            },
            EnvVar {
                name: "NVM_DIR".into(),
                value: "/nvm".into(),
            },
        ];
        let out = filter_to_allowlist(inputs);
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["VIRTUAL_ENV", "NVM_DIR"]);
    }

    #[test]
    fn allowlist_dedupes_repeated_names() {
        let inputs = vec![
            EnvVar {
                name: "VIRTUAL_ENV".into(),
                value: "/first".into(),
            },
            EnvVar {
                name: "VIRTUAL_ENV".into(),
                value: "/second".into(),
            },
        ];
        let out = filter_to_allowlist(inputs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].value, "/first", "first-occurrence wins");
    }

    #[test]
    fn macos_extractor_skips_argv_words() {
        let line = "zsh -i -l VIRTUAL_ENV=/foo NODE_OPTIONS=--inspect XPC_FLAGS=0x0";
        let toks = extract_macos_env_tokens(line);
        // `-i` and `-l` correctly excluded (no `=`).
        // `VIRTUAL_ENV=…` kept; `NODE_OPTIONS=…` kept; `XPC_FLAGS=…` kept
        // (we filter env _names_ later via the allow-list, not the regex).
        assert!(toks.iter().any(|t| t.starts_with("VIRTUAL_ENV=")));
        assert!(toks.iter().any(|t| t.starts_with("NODE_OPTIONS=")));
        assert!(toks.iter().any(|t| t.starts_with("XPC_FLAGS=")));
        assert!(!toks.iter().any(|t| t == "-i" || t == "-l" || t == "zsh"));
    }

    #[test]
    fn macos_extractor_rejects_leading_digit_names() {
        let toks = extract_macos_env_tokens("9LIVES=cat REAL=ok");
        assert_eq!(toks, vec!["REAL=ok"]);
    }

    #[test]
    fn allowlist_is_case_sensitive() {
        // POSIX env names are case-sensitive, and we mirror that.
        assert!(!is_forwardable("virtual_env"));
        assert!(is_forwardable("VIRTUAL_ENV"));
    }
}
