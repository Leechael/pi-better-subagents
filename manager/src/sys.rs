//! Tiny Unix process-control seam (design doc §3.4).
//!
//! All production `unsafe` for this crate lives here. Callers use the safe
//! wrappers below; the only unavoidable `unsafe` is `CommandExt::pre_exec`,
//! which the std/tokio API marks unsafe because the closure runs between
//! fork and exec (async-signal-safe only).
//!
//! Invariants documented per function.

use std::io;
use std::os::unix::process::CommandExt;

/// POSIX SIGTERM — process-group stop (§3.2 / §3.4).
pub const SIGTERM: i32 = libc::SIGTERM;
/// POSIX SIGKILL — hard kill after grace (§3.2 / §3.4).
pub const SIGKILL: i32 = libc::SIGKILL;

/// Make the child a session leader (`setsid`) so `pgid == pid` and
/// [`signal_group`] can address the whole tree with `kill(-pgid, …)`.
///
/// # Safety boundary
/// `pre_exec` is the only `unsafe` call site. Inside the closure we only
/// call `setsid`, which is async-signal-safe.
pub fn apply_new_session_tokio(cmd: &mut tokio::process::Command) {
    // SAFETY: closure only calls async-signal-safe `setsid`.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Same as [`apply_new_session_tokio`] for `std::process::Command`
/// (used when detaching the daemon itself from a short-lived CLI).
pub fn apply_new_session_std(cmd: &mut std::process::Command) {
    // SAFETY: closure only calls async-signal-safe `setsid`.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Signal the process group led by `pid` (session leader ⇒ `pgid == pid`).
/// `ESRCH` (already dead) is treated as success.
///
/// # Safety boundary
/// `kill` with a negative pid is a single libc call; no fd ownership.
pub fn signal_group(pid: u32, sig: i32) -> io::Result<()> {
    // SAFETY: `pid`/`sig` are plain integers; negative pid means process group.
    let rc = unsafe { libc::kill(-(pid as i32), sig) };
    if rc == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    if e.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(e)
    }
}

/// `kill(pid, 0)` liveness probe. `EPERM` counts as alive (process exists
/// but we lack permission to signal it).
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 is a pure existence check; no side effects on success.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Process group id for `pid`, or `None` on error.
#[cfg(test)]
pub fn getpgid(pid: u32) -> Option<i32> {
    // SAFETY: getpgid is a pure query.
    let pg = unsafe { libc::getpgid(pid as i32) };
    if pg < 0 {
        None
    } else {
        Some(pg)
    }
}

/// Peak resident set size for this process (bytes on Darwin, KiB on Linux).
/// Used only by optional leak/RSS regression tests.
#[cfg(test)]
pub fn max_rss_raw() -> u64 {
    // SAFETY: getrusage fills a stack-allocated rusage; no aliasing.
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return 0;
        }
        usage.ru_maxrss as u64
    }
}

/// Normalize [`max_rss_raw`] to bytes on both Darwin and Linux.
#[cfg(test)]
pub fn max_rss_bytes() -> u64 {
    let raw = max_rss_raw();
    if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        raw // Darwin: bytes
    } else {
        raw.saturating_mul(1024) // Linux: kilobytes
    }
}
