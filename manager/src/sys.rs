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
/// [`signal_group`] can address the whole tree with `kill(-pgid, …)`, and
/// let it inherit only fds 0, 1 and 2 (see [`child_setup`]).
///
/// # Safety boundary
/// `pre_exec` is the only `unsafe` call site. The closure calls only
/// `setsid`, `fcntl` and (Linux) the `close_range` syscall, all
/// async-signal-safe, and allocates nothing: the fd bound is computed here,
/// before fork.
pub fn apply_new_session_tokio(cmd: &mut tokio::process::Command) {
    let limit = fd_scan_limit();
    // SAFETY: see above; `limit` is a captured integer.
    unsafe {
        cmd.pre_exec(move || child_setup(limit));
    }
}

/// Same as [`apply_new_session_tokio`] for `std::process::Command`
/// (used when detaching the daemon itself from a short-lived CLI).
pub fn apply_new_session_std(cmd: &mut std::process::Command) {
    let limit = fd_scan_limit();
    // SAFETY: as for `apply_new_session_tokio`.
    unsafe {
        cmd.pre_exec(move || child_setup(limit));
    }
}

/// Runs in the forked child, before exec.
///
/// Every fd ≥ 3 is marked close-on-exec, so the new program starts with
/// stdin/stdout/stderr only. Rust sets FD_CLOEXEC on its descriptors, but
/// on macOS only after `socket()`/`accept()` return. A fork in that window
/// (a task starting while a client connects) would otherwise give the task
/// a copy of a client connection. That client would then see no EOF when
/// the daemon closes the connection, until the task exits. The same applies
/// to anything the daemon inherited without the flag.
///
/// The fds are marked, not closed: std's fork path reports exec failures to
/// the parent over a close-on-exec pipe, which must stay open until exec.
/// The effect after exec is the same.
fn child_setup(limit: i32) -> io::Result<()> {
    if unsafe { libc::setsid() } == -1 {
        return Err(io::Error::last_os_error());
    }
    // Linux ≥ 5.11: one syscall. Older kernels (ENOSYS / EINVAL) fall back.
    #[cfg(target_os = "linux")]
    {
        let r = unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, libc::CLOSE_RANGE_CLOEXEC) };
        if r == 0 {
            return Ok(());
        }
    }
    for fd in 3..limit {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        }
    }
    Ok(())
}

/// Upper bound for the fd scan in [`child_setup`], computed in the parent
/// before fork (the child must not allocate).
///
/// The highest fd open right now (from `/dev/fd`), plus slack for fds other
/// threads open before the fork. A new fd takes the lowest free number, so
/// it lands at most one past the current highest per concurrent open.
/// Never above the soft RLIMIT_NOFILE, where no fd can exist. That limit
/// alone is not used as the bound, because it is often 10^6 (raised by
/// shells and cargo): even capped at 65536 it made every spawn cost ~65k
/// syscalls. Without `/dev/fd`, the limit (capped) is the bound.
fn fd_scan_limit() -> i32 {
    const CAP: i64 = 1 << 16;
    const SLACK: i64 = 64;
    let mut rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    let soft = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) } == 0 {
        i64::try_from(rl.rlim_cur).unwrap_or(CAP).min(CAP)
    } else {
        CAP
    };
    let highest = std::fs::read_dir("/dev/fd").ok().and_then(|d| {
        d.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<i64>().ok())
            .max()
    });
    match highest {
        Some(h) => (h + 1 + SLACK).min(soft) as i32,
        None => soft as i32,
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

/// Local broken-down time for epoch seconds (`localtime_r`).
///
/// # Safety boundary
/// `localtime_r` writes only into the `tm` we own.
pub fn localtime(secs: i64) -> libc::tm {
    let t = secs as libc::time_t;
    // SAFETY: both pointers are valid for the duration of the call.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    }
}

/// Columns of the terminal on stdout, or None when stdout is not a tty.
///
/// # Safety boundary
/// `isatty` and `ioctl(TIOCGWINSZ)` only read fd 1 and fill our `winsize`.
pub fn stdout_tty_columns() -> Option<usize> {
    // SAFETY: isatty on a valid fd number has no side effects.
    if unsafe { libc::isatty(1) } != 1 {
        return None;
    }
    // SAFETY: TIOCGWINSZ fills the winsize we pass.
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            return Some(ws.ws_col as usize);
        }
    }
    Some(80)
}

/// `kill(-pgid, 0)`: does any process remain in the group led by `pgid`?
/// POSIX does not reuse a pid while a process group with that id exists, so
/// a group we have watched continuously is still ours while this is true.
pub fn group_alive(pgid: u32) -> bool {
    if pgid == 0 {
        return false;
    }
    // SAFETY: signal 0 to a negative pid is a pure existence check.
    let rc = unsafe { libc::kill(-(pgid as i32), 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `kill(pid, 0)` liveness probe. `EPERM` counts as alive (process exists
/// but we lack permission to signal it).
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 is a pure existence check; no side effects on success.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
