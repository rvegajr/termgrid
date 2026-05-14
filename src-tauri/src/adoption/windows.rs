//! Windows-specific CWD/TTY probes for session adoption.
//!
//! **v3:** real CWD lookup via the same PEB-walking trick every
//! process-introspection tool uses on Windows (Process Explorer, etc).
//!
//! Sequence:
//!  1. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ)`
//!  2. `NtQueryInformationProcess(ProcessBasicInformation)` to get the
//!     process's PEB base address.
//!  3. `ReadProcessMemory` to copy the PEB.
//!  4. `ReadProcessMemory` again to copy the `RTL_USER_PROCESS_PARAMETERS`.
//!  5. `ReadProcessMemory` once more for the `UNICODE_STRING` buffer
//!     describing `CurrentDirectory.DosPath`.
//!  6. Convert the UTF-16 buffer to a Rust `String`.
//!
//! All structs are hand-rolled `#[repr(C)]` because the `windows` crate
//! doesn't expose the (semi-)private NT types we need. They're stable
//! enough — Windows has shipped them unchanged since Vista — but we keep
//! a tight surface area and tag the unsafe sites with safety comments.
//!
//! **TTY:** Windows doesn't have POSIX TTYs. ConPTY pseudo-consoles
//! exist, but their handle id isn't a user-meaningful name, so we keep
//! `tty_of_pid` returning `None` for v3. v4 can return the ConPTY
//! handle-id string if there's user demand.
//!
//! This file compiles unchanged on macOS/Linux because both functions
//! are gated by the `cfg(target_os = "windows")` exposure in
//! `super::cwd_of_pid` / `super::tty_of_pid`.

#![allow(unused_imports, dead_code, clippy::missing_safety_doc)]

#[cfg(target_os = "windows")]
mod imp {
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use windows::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessBasicInformation, PROCESSINFOCLASS,
    };
    use windows::Win32::Foundation::{CloseHandle, HANDLE, NTSTATUS, STATUS_SUCCESS};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    /// Mirror of the public layout of `PROCESS_BASIC_INFORMATION`. The
    /// `windows` crate ships its own copy but only in the `Wdk` module
    /// behind a feature flag; this hand-rolled version keeps us
    /// independent of future feature splits in the crate.
    ///
    /// All pointer fields are reported as `usize` because we only need
    /// them as opaque address values to feed back into
    /// `ReadProcessMemory`.
    #[repr(C)]
    struct ProcessBasicInfo {
        exit_status: NTSTATUS,
        peb_base_address: usize,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    /// Hand-rolled `PEB` subset.
    ///
    /// We only need `ProcessParameters` (offset 0x20 on 64-bit Windows).
    /// We over-allocate the leading padding so reads on 32-bit Windows
    /// degrade safely — `ReadProcessMemory` will short-read into the
    /// `process_parameters` field at the correct offset on either arch.
    /// In practice TermGrid only ships as a 64-bit binary, so the 64-bit
    /// layout is the one that matters.
    #[repr(C)]
    struct PebSubset {
        _padding: [u8; 0x20],
        process_parameters: usize,
    }

    /// `UNICODE_STRING` as Windows defines it.
    ///
    /// `length` and `maximum_length` are byte counts (not char counts) of
    /// the UTF-16 buffer at `buffer`. We treat `buffer` as an opaque
    /// remote-process address.
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        _padding: u32,
        buffer: usize,
    }

    /// Subset of `RTL_USER_PROCESS_PARAMETERS` covering the
    /// `CurrentDirectory.DosPath` field on 64-bit Windows.
    ///
    /// Layout reference: `RtlGetProcessHeap` private docs, mirrored in
    /// `phnt`. CurrentDirectory is at offset 0x38 on 64-bit; it's a
    /// `CURDIR` (UNICODE_STRING + HANDLE) so the path itself sits at
    /// 0x38. We model that with leading padding.
    #[repr(C)]
    struct ProcessParametersSubset {
        _padding: [u8; 0x38],
        current_directory_dos_path: UnicodeString,
    }

    /// Maximum byte length we'll accept for a remote UTF-16 path before
    /// bailing out. Windows path API limit is 32_767 chars (long paths);
    /// we cap at twice that as a sanity belt.
    const MAX_PATH_BYTES: usize = 64 * 1024;

    /// Public entry point — never panics, never blocks. Returns `None`
    /// on any failure: process exited, permission denied, struct layout
    /// mismatch on an exotic build, etc.
    pub fn cwd_of_pid(pid: u32) -> Option<String> {
        unsafe { cwd_of_pid_inner(pid) }
    }

    unsafe fn cwd_of_pid_inner(pid: u32) -> Option<String> {
        // Step 1: open the process with the bare-minimum rights.
        // PROCESS_QUERY_LIMITED_INFORMATION works on protected processes
        // where PROCESS_QUERY_INFORMATION would fail; we add PROCESS_VM_READ
        // for ReadProcessMemory.
        let handle: HANDLE = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        if handle.is_invalid() {
            return None;
        }

        // RAII guard so we don't leak the handle on any of the many
        // early-return paths below.
        struct CloseOnDrop(HANDLE);
        impl Drop for CloseOnDrop {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _guard = CloseOnDrop(handle);

        // Step 2: NtQueryInformationProcess(ProcessBasicInformation).
        let mut pbi: MaybeUninit<ProcessBasicInfo> = MaybeUninit::uninit();
        let mut returned: u32 = 0;
        let status: NTSTATUS = NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            pbi.as_mut_ptr() as *mut c_void,
            size_of::<ProcessBasicInfo>() as u32,
            &mut returned as *mut u32,
        );
        if status != STATUS_SUCCESS {
            return None;
        }
        let pbi = pbi.assume_init();
        if pbi.peb_base_address == 0 {
            return None;
        }

        // Step 3: read the PEB.
        let mut peb: MaybeUninit<PebSubset> = MaybeUninit::uninit();
        let mut bytes_read: usize = 0;
        ReadProcessMemory(
            handle,
            pbi.peb_base_address as *const c_void,
            peb.as_mut_ptr() as *mut c_void,
            size_of::<PebSubset>(),
            Some(&mut bytes_read as *mut usize),
        )
        .ok()?;
        if bytes_read < size_of::<PebSubset>() {
            return None;
        }
        let peb = peb.assume_init();
        if peb.process_parameters == 0 {
            return None;
        }

        // Step 4: read the RTL_USER_PROCESS_PARAMETERS subset.
        let mut params: MaybeUninit<ProcessParametersSubset> = MaybeUninit::uninit();
        ReadProcessMemory(
            handle,
            peb.process_parameters as *const c_void,
            params.as_mut_ptr() as *mut c_void,
            size_of::<ProcessParametersSubset>(),
            Some(&mut bytes_read as *mut usize),
        )
        .ok()?;
        if bytes_read < size_of::<ProcessParametersSubset>() {
            return None;
        }
        let params = params.assume_init();

        // Step 5: read the UTF-16 path buffer.
        let path = &params.current_directory_dos_path;
        if path.buffer == 0 || path.length == 0 {
            return None;
        }
        let byte_len = path.length as usize;
        if byte_len > MAX_PATH_BYTES || byte_len % 2 != 0 {
            return None;
        }
        let mut wbuf: Vec<u16> = vec![0u16; byte_len / 2];
        ReadProcessMemory(
            handle,
            path.buffer as *const c_void,
            wbuf.as_mut_ptr() as *mut c_void,
            byte_len,
            Some(&mut bytes_read as *mut usize),
        )
        .ok()?;
        if bytes_read < byte_len {
            return None;
        }

        // Step 6: stringify, trim any trailing NUL/backslash.
        let s = String::from_utf16_lossy(&wbuf);
        let trimmed = s.trim_end_matches(['\0', '\\']);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    /// Windows has no POSIX TTY abstraction. ConPTY assigns each console
    /// process a pseudo-console handle id, but it's not user-meaningful,
    /// so we leave this as `None` until v4 surfaces a real use case.
    pub fn tty_of_pid(_pid: u32) -> Option<String> {
        None
    }
}

#[cfg(target_os = "windows")]
pub(super) use imp::{cwd_of_pid, tty_of_pid};

#[cfg(not(target_os = "windows"))]
pub(super) fn cwd_of_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
pub(super) fn tty_of_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn non_windows_returns_none() {
        // On the non-Windows builds we exercise on macOS/Linux CI, the
        // stub must always return None for both probes. Trivially true
        // by construction, but tested so the gate fails loudly if anyone
        // wires Windows code paths back through a non-cfg path.
        assert_eq!(super::cwd_of_pid(1234), if cfg!(target_os = "windows") {
            super::cwd_of_pid(1234)
        } else {
            None
        });
        assert_eq!(super::tty_of_pid(1234), None);
    }
}
