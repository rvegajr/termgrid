//! Parse the ssh command line out of a candidate shell's ancestry.
//!
//! When a TermGrid user adopts a shell that's *inside* an ssh session,
//! v1 dropped them at the local ssh client's CWD — useless, because the
//! interesting context is on the remote host. v2 walks the ancestry,
//! finds the ssh process, reads its argv via `ps -o args=`, parses out
//! the destination/port/remote-command, and lets the picker offer a
//! one-click reconnect.
//!
//! Parsing strategy: handle the OpenSSH client's argv conventions
//! conservatively. We're not trying to fully emulate ssh(1) — we just
//! need destination, optional `-p`, and the optional trailing command.
//! Flags we don't understand are passed through to the reconnect
//! invocation as-is, so the user's `-i`/`-J`/`-L` etc. survive.

use super::types::SshTarget;

/// Argv flags that take an argument (we must skip the following token
/// when looking for the destination). Trimmed list — only the ones
/// commonly used in interactive ssh.
const FLAGS_WITH_ARG: &[&str] = &[
    "-p", "-l", "-i", "-J", "-L", "-R", "-D", "-W", "-O", "-S", "-E", "-F", "-o", "-c", "-m", "-Q",
    "-b", "-e", "-I", "-B",
];

/// Read the argv of `pid` via `ps -o args=` and parse it into an
/// [`SshTarget`]. Returns `None` if the process isn't ssh, or if we
/// couldn't find a destination.
///
/// Cross-platform: `ps -o args=` works on macOS, Linux, and most BSDs.
/// On Windows we always return `None` (no ssh-adoption support there yet).
pub fn parse_ssh_for_pid(pid: u32) -> Option<SshTarget> {
    #[cfg(target_family = "unix")]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "args=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        parse_ssh_command_line(&line)
    }
    #[cfg(not(target_family = "unix"))]
    {
        let _ = pid;
        None
    }
}

/// Tokenize an ssh command line and extract its target shape.
///
/// Pure function — exercised by unit tests. We accept the raw `ps` line
/// (executable + args, space-separated) and return a parsed
/// [`SshTarget`] if it looks like ssh.
///
/// Returns `None` for non-ssh invocations (different exe basename) and
/// for ssh invocations with no extractable destination (e.g. `ssh
/// --help`).
pub fn parse_ssh_command_line(line: &str) -> Option<SshTarget> {
    let tokens = tokenize_argv(line);
    if tokens.is_empty() {
        return None;
    }
    let exe = std::path::Path::new(&tokens[0])
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if !exe.eq_ignore_ascii_case("ssh") && !exe.eq_ignore_ascii_case("mosh") {
        return None;
    }

    // Walk args looking for the first positional (destination).
    let mut port: Option<u16> = None;
    let mut destination: Option<String> = None;
    let mut command: Option<String> = None;
    let mut i = 1;
    while i < tokens.len() {
        let t = &tokens[i];
        if t == "--" {
            // Everything after `--` is the remote command.
            command = if i + 1 < tokens.len() {
                Some(tokens[i + 1..].join(" "))
            } else {
                None
            };
            break;
        }
        if let Some(stripped) = t.strip_prefix("-p") {
            // Either `-p2222` or `-p 2222`.
            if !stripped.is_empty() {
                port = stripped.parse().ok();
                i += 1;
                continue;
            }
            if let Some(next) = tokens.get(i + 1) {
                port = next.parse().ok();
                i += 2;
                continue;
            }
        }
        if FLAGS_WITH_ARG.iter().any(|f| *f == t) {
            // Consume the flag and its argument.
            i += 2;
            continue;
        }
        if t.starts_with('-') {
            // Bare boolean flag — `-v`, `-A`, `-X`, etc.
            i += 1;
            continue;
        }
        // First positional: destination.
        if destination.is_none() {
            destination = Some(t.clone());
            i += 1;
            // Remaining tokens (if any) are the remote command. Skip a
            // single `--` separator if present — it's a positional-args
            // marker, not part of the remote command itself.
            if i < tokens.len() && tokens[i] == "--" {
                i += 1;
            }
            if i < tokens.len() {
                command = Some(tokens[i..].join(" "));
            }
            break;
        }
        i += 1;
    }

    let dest = destination?;
    Some(SshTarget {
        destination: dest,
        port,
        command,
        argv: tokens,
    })
}

/// Naive whitespace splitter with minimal quote awareness.
///
/// `ps -o args=` produces a single line where each argv token is
/// separated by single spaces, with no shell-style quoting. If the user
/// invoked ssh with `'remote command with spaces'`, ps will report the
/// already-unquoted form, so we don't need to handle nested quotes.
/// However we still strip surrounding single/double quotes per-token
/// defensively, since some ps variants do preserve them.
fn tokenize_argv(line: &str) -> Vec<String> {
    line.split_whitespace()
        .map(|t| strip_quotes(t).to_string())
        .collect()
}

fn strip_quotes(t: &str) -> &str {
    let bytes = t.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Render an [`SshTarget`] back into a reconnect command string that's
/// safe to write into a shell.
///
/// Quoting: we deliberately *don't* try to fully re-escape — the
/// destination and port are constrained, and remote commands are
/// passed through verbatim. The frontend can show the rendered string
/// to the user before they hit Enter, which is the real safety net.
pub fn render_reconnect_command(target: &SshTarget) -> String {
    render_reconnect_command_with_send_env(target, &[])
}

/// **v3:** Like [`render_reconnect_command`] but also forwards selected
/// environment variable *names* via OpenSSH's `-o SendEnv=` option.
///
/// `send_env_names` is a flat list of variable names (not `NAME=VALUE`
/// pairs). The values themselves must already be exported in the local
/// shell — that's how ssh's SendEnv works on the wire. Callers
/// (`App.tsx::adoptSession`) typically `export NAME='value'` immediately
/// before invoking ssh.
///
/// We rate-limit how many vars we forward (16) since SSH servers
/// commonly reject overly long `SendEnv` lists. Names with characters
/// that aren't `[A-Z_][A-Z0-9_]*` are silently dropped — ssh would
/// reject them anyway.
pub fn render_reconnect_command_with_send_env(
    target: &SshTarget,
    send_env_names: &[&str],
) -> String {
    let mut parts: Vec<String> = vec!["ssh".to_string()];
    for name in send_env_names.iter().take(16) {
        if is_valid_env_name(name) {
            parts.push("-o".to_string());
            parts.push(format!("SendEnv={}", name));
        }
    }
    if let Some(p) = target.port {
        parts.push("-p".to_string());
        parts.push(p.to_string());
    }
    parts.push(target.destination.clone());
    if let Some(cmd) = &target.command {
        parts.push(cmd.clone());
    }
    parts.join(" ")
}

/// Conservative POSIX env-name validity check: ASCII, starts with
/// letter or underscore, body is alnum or underscore. Mirrors what ssh
/// itself accepts on the wire and avoids shell-injection vectors.
pub(crate) fn is_valid_env_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bytes = name.as_bytes();
    if !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_invocation() {
        let t = parse_ssh_command_line("ssh me@host").unwrap();
        assert_eq!(t.destination, "me@host");
        assert_eq!(t.port, None);
        assert_eq!(t.command, None);
    }

    #[test]
    fn parses_with_port_spaced() {
        let t = parse_ssh_command_line("ssh -p 2222 me@host").unwrap();
        assert_eq!(t.destination, "me@host");
        assert_eq!(t.port, Some(2222));
    }

    #[test]
    fn parses_with_port_joined() {
        let t = parse_ssh_command_line("ssh -p2222 me@host").unwrap();
        assert_eq!(t.destination, "me@host");
        assert_eq!(t.port, Some(2222));
    }

    #[test]
    fn skips_flag_with_arg() {
        let t = parse_ssh_command_line("ssh -i /tmp/key.pem -L 8080:localhost:80 me@host")
            .unwrap();
        assert_eq!(t.destination, "me@host");
    }

    #[test]
    fn skips_bare_boolean_flag() {
        let t = parse_ssh_command_line("ssh -v -A -X me@host").unwrap();
        assert_eq!(t.destination, "me@host");
    }

    #[test]
    fn captures_trailing_command() {
        let t = parse_ssh_command_line("ssh me@host htop -d 5").unwrap();
        assert_eq!(t.destination, "me@host");
        assert_eq!(t.command.as_deref(), Some("htop -d 5"));
    }

    #[test]
    fn captures_command_after_dashdash() {
        let t = parse_ssh_command_line("ssh me@host -- ls -la").unwrap();
        assert_eq!(t.destination, "me@host");
        assert_eq!(t.command.as_deref(), Some("ls -la"));
    }

    #[test]
    fn rejects_non_ssh_exe() {
        assert!(parse_ssh_command_line("bash -c 'echo hi'").is_none());
        assert!(parse_ssh_command_line("scp file me@host:/").is_none());
    }

    #[test]
    fn handles_absolute_path_to_ssh() {
        let t = parse_ssh_command_line("/usr/bin/ssh me@host").unwrap();
        assert_eq!(t.destination, "me@host");
    }

    #[test]
    fn returns_none_when_only_flags_present() {
        // `ssh -v` alone — no destination.
        assert!(parse_ssh_command_line("ssh -v").is_none());
    }

    #[test]
    fn render_reconnect_minimal() {
        let target = SshTarget {
            destination: "me@host".into(),
            port: None,
            command: None,
            argv: vec!["ssh".into(), "me@host".into()],
        };
        assert_eq!(render_reconnect_command(&target), "ssh me@host");
    }

    #[test]
    fn render_reconnect_with_port_and_command() {
        let target = SshTarget {
            destination: "me@host".into(),
            port: Some(2222),
            command: Some("htop".into()),
            argv: vec![],
        };
        assert_eq!(
            render_reconnect_command(&target),
            "ssh -p 2222 me@host htop"
        );
    }

    #[test]
    fn empty_line_returns_none() {
        assert!(parse_ssh_command_line("").is_none());
        assert!(parse_ssh_command_line("   ").is_none());
    }

    #[test]
    fn render_with_send_env_emits_per_name_flags() {
        let target = SshTarget {
            destination: "me@host".into(),
            port: None,
            command: None,
            argv: vec![],
        };
        let out =
            render_reconnect_command_with_send_env(&target, &["VIRTUAL_ENV", "AWS_PROFILE"]);
        assert_eq!(
            out,
            "ssh -o SendEnv=VIRTUAL_ENV -o SendEnv=AWS_PROFILE me@host"
        );
    }

    #[test]
    fn render_with_send_env_drops_invalid_names() {
        let target = SshTarget {
            destination: "me@host".into(),
            port: None,
            command: None,
            argv: vec![],
        };
        // Bad names: leading digit, dash, space, semicolon-injection.
        let out = render_reconnect_command_with_send_env(
            &target,
            &["1BAD", "OK", "WITH-DASH", "WITH SPACE", "$(boom)"],
        );
        assert_eq!(out, "ssh -o SendEnv=OK me@host");
    }

    #[test]
    fn render_with_send_env_caps_at_sixteen() {
        let target = SshTarget {
            destination: "me@host".into(),
            port: None,
            command: None,
            argv: vec![],
        };
        let names: Vec<String> = (0..30).map(|i| format!("VAR_{}", i)).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let out = render_reconnect_command_with_send_env(&target, &refs);
        // We emit `-o SendEnv=` 16 times.
        let count = out.matches("SendEnv=").count();
        assert_eq!(count, 16);
    }

    #[test]
    fn is_valid_env_name_basics() {
        assert!(is_valid_env_name("FOO"));
        assert!(is_valid_env_name("_BAR"));
        assert!(is_valid_env_name("BAR_BAZ_1"));
        assert!(!is_valid_env_name(""));
        assert!(!is_valid_env_name("1BAD"));
        assert!(!is_valid_env_name("WITH-DASH"));
        assert!(!is_valid_env_name("WITH SPACE"));
    }

    #[test]
    fn strips_token_quotes_defensively() {
        let t = parse_ssh_command_line("'ssh' 'me@host'").unwrap();
        assert_eq!(t.destination, "me@host");
    }
}
