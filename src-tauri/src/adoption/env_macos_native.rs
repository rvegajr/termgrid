//! **v5:** macOS native environment capture via `KERN_PROCARGS2` sysctl.
//!
//! The original v5 plan was to read process env via `task_for_pid` +
//! `mach_vm_read`, gated on the `com.apple.security.cs.debugger`
//! entitlement. That works only on signed/notarized builds and pulls in a
//! lot of unsafe Mach FFI. There's a much simpler path that works *today*,
//! on every unsigned build, without any entitlement: the kernel exposes
//! every user-owned process's argv+env via the `KERN_PROCARGS2` sysctl —
//! the same mechanism `ps -E` uses, but read directly so we get the full
//! buffer instead of the whitespace-mangled `ps` formatting.
//!
//! Constraints honored:
//! - Only readable for processes the same uid owns (good; matches our
//!   adoption use case — you don't adopt root's shells).
//! - Result is hard-capped at the kernel's exec arg-max (~256 KB).
//! - Filtered through `super::env_capture::filter_to_allowlist` so we
//!   never surface secrets, exactly like the other env paths.
//!
//! Wire format of the KERN_PROCARGS2 buffer:
//! ```text
//! [ i32   argc                                    ]
//! [ cstr  exec_path                               ]
//! [ pad   zero bytes until next non-zero          ]
//! [ cstr  argv[0]                                 ]
//! ...
//! [ cstr  argv[argc-1]                            ]
//! [ cstr  env[0]   "KEY=VALUE\0"                  ]
//! ...
//! [ cstr  env[N-1] "KEY=VALUE\0"                  ]
//! ```

#[cfg(target_os = "macos")]
use super::env_capture::{filter_to_allowlist, parse_kv};
#[cfg(target_os = "macos")]
use super::types::EnvVar;

#[cfg(target_os = "macos")]
const CTL_KERN: libc::c_int = 1;
#[cfg(target_os = "macos")]
const KERN_PROCARGS2: libc::c_int = 49;

/// Read environment variables for `pid` via `KERN_PROCARGS2`.
///
/// Returns an empty vec on any failure (different uid, missing process,
/// sysctl error, parse error). Never panics.
#[cfg(target_os = "macos")]
pub fn env_via_task_for_pid(pid: u32) -> Vec<EnvVar> {
    let raw = match read_procargs2(pid) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let entries = parse_env_from_procargs2(&raw);
    filter_to_allowlist(entries.into_iter().filter_map(|s| parse_kv(&s)))
}

/// Issue the two-step sysctl: first call sizes the buffer, second fills it.
#[cfg(target_os = "macos")]
fn read_procargs2(pid: u32) -> Option<Vec<u8>> {
    unsafe {
        let mut mib: [libc::c_int; 3] = [CTL_KERN, KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        let rc = libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            std::ptr::null_mut(),
            &mut size as *mut libc::size_t,
            std::ptr::null_mut(),
            0,
        );
        if rc != 0 || size == 0 {
            return None;
        }
        let mut buf: Vec<u8> = vec![0u8; size];
        let rc = libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buf.as_mut_ptr().cast::<libc::c_void>(),
            &mut size as *mut libc::size_t,
            std::ptr::null_mut(),
            0,
        );
        if rc != 0 {
            return None;
        }
        buf.truncate(size);
        Some(buf)
    }
}

/// Parse the KERN_PROCARGS2 buffer and return the `KEY=VALUE` strings of
/// the env block. Pure on the input; testable.
///
/// We tolerate unexpected truncation: any step that runs off the end
/// returns an empty list rather than panicking.
#[cfg(target_os = "macos")]
pub(crate) fn parse_env_from_procargs2(buf: &[u8]) -> Vec<String> {
    parse_env_impl(buf)
}

#[cfg(target_os = "macos")]
fn parse_env_impl(buf: &[u8]) -> Vec<String> {
    if buf.len() < 4 {
        return Vec::new();
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 0 {
        return Vec::new();
    }
    let mut i = 4usize;
    // exec_path: cstring, then zero padding until next non-zero byte.
    while i < buf.len() && buf[i] != 0 {
        i += 1;
    }
    while i < buf.len() && buf[i] == 0 {
        i += 1;
    }
    // argv: `argc` null-terminated strings.
    for _ in 0..argc {
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        if i < buf.len() {
            i += 1; // skip the null
        }
    }
    // env block: null-terminated strings until we hit either an empty
    // string (env-block terminator on some macOS versions) or EOF.
    let mut out = Vec::new();
    while i < buf.len() {
        let start = i;
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        if i == start {
            break;
        }
        if let Ok(s) = std::str::from_utf8(&buf[start..i]) {
            if s.contains('=') {
                out.push(s.to_string());
            }
        }
        if i < buf.len() {
            i += 1;
        }
    }
    out
}

// Stub for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub fn env_via_task_for_pid(_pid: u32) -> Vec<super::types::EnvVar> {
    Vec::new()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Build a synthetic KERN_PROCARGS2 buffer:
    /// argc=1, exec_path="/bin/zsh", argv=["zsh"], env=["PATH=/usr/bin", "HOME=/u/me"].
    fn make_buf() -> Vec<u8> {
        let mut buf = Vec::new();
        // argc = 1
        buf.extend_from_slice(&1i32.to_ne_bytes());
        // exec_path
        buf.extend_from_slice(b"/bin/zsh\0");
        // zero padding (typical KERN_PROCARGS2 layout pads to 8-byte boundary)
        buf.extend_from_slice(&[0u8; 4]);
        // argv[0]
        buf.extend_from_slice(b"zsh\0");
        // env
        buf.extend_from_slice(b"PATH=/usr/bin\0");
        buf.extend_from_slice(b"HOME=/u/me\0");
        buf
    }

    #[test]
    fn parses_synthetic_env_block() {
        let buf = make_buf();
        let out = parse_env_from_procargs2(&buf);
        assert_eq!(
            out,
            vec!["PATH=/usr/bin".to_string(), "HOME=/u/me".to_string()]
        );
    }

    #[test]
    fn truncated_buffer_yields_empty() {
        assert!(parse_env_from_procargs2(&[]).is_empty());
        assert!(parse_env_from_procargs2(&[0, 0, 0]).is_empty());
    }

    #[test]
    fn negative_argc_is_safe() {
        let mut buf = (-1i32).to_ne_bytes().to_vec();
        buf.extend_from_slice(b"junk");
        assert!(parse_env_from_procargs2(&buf).is_empty());
    }
}
