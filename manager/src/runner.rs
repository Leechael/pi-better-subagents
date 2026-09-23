//! `pbs-manager __run <command>`: the leader of every task's process group
//! (design doc §3.2 / §3.4).
//!
//! The daemon spawns this runner as a session leader instead of `sh -c`
//! directly. It starts with two extra descriptors:
//!
//! - fd 3, the LIFELINE: the read end of a pipe whose write end only the
//!   daemon holds. When the daemon ends by any means (`shutdown`, `kill -9`,
//!   a panic), the kernel closes that write end and this read returns EOF.
//!   The runner then SIGTERMs its process group, waits the 2 s grace, and
//!   SIGKILLs it: no task outlives its manager.
//! - fd 4, STATUS: the write end of this task's status pipe. When the
//!   command exits, the runner writes one line with its real status, then
//!   exits too if nothing else is left in the group. If the command left
//!   descendants behind (`cmd &`), the runner stays as the group's guardian,
//!   still holding the lifeline, until the group empties. The daemon reads
//!   "the group is empty" from the runner's own exit.
//!
//! Status line (the daemon/runner contract; keep it stable, since a daemon
//! may spawn a newer runner binary after an in-place upgrade):
//!   `exit <code> <alone|linger>\n` or `signal <n> <alone|linger>\n`
//!
//! The runner blocks SIGTERM, so a group SIGTERM (stop, shutdown) reaches
//! the command while the runner lives to report how the command ended. The
//! child unblocks it right before exec. A handler would not do: a SIGTERM
//! landing between the fork and the exec of `sh` would run the inherited
//! handler in the child and be lost; blocked, it stays pending and acts the
//! moment the child unblocks it. SIGKILL takes the runner down with the
//! group; the daemon then falls back to the runner's own wait status.

use crate::sys::{self, RUNNER_LIFELINE_FD, RUNNER_STATUS_FD};
use std::os::unix::process::ExitStatusExt;
use std::time::Duration;

/// Grace between the group SIGTERM and SIGKILL when the lifeline breaks
/// (the same 2 s as the daemon's stop/shutdown, §3.2).
const LIFELINE_GRACE: Duration = Duration::from_secs(2);
/// How often a guardian looks for remaining group members.
const GUARD_POLL: Duration = Duration::from_millis(100);

pub fn main(command: &str) -> i32 {
    // Neither descriptor may reach the command.
    let _ = sys::set_cloexec(RUNNER_LIFELINE_FD);
    let _ = sys::set_cloexec(RUNNER_STATUS_FD);
    // Before any thread exists, so every thread inherits the mask.
    let _ = sys::block_signal(libc::SIGTERM);

    let me = sys::getpid();
    std::thread::spawn(move || watch_lifeline(me));

    // Same process group (the runner leads it); fds 0-2 are inherited.
    let mut sh = std::process::Command::new("/bin/sh");
    sh.arg("-c").arg(command);
    sys::unblock_in_child(&mut sh, libc::SIGTERM);
    let mut child = match sh.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("pbs-manager: cannot run /bin/sh: {e}");
            report("exit 127", alone(me));
            return 127;
        }
    };
    // A group SIGTERM (an early stop) that reached only us, before `sh`
    // existed, is pending here: pass it on now that `sh` is in the group.
    // If `sh` got it too, a second SIGTERM changes nothing.
    if sys::signal_pending(libc::SIGTERM) {
        let _ = sys::signal_group(me, sys::SIGTERM);
    }
    let status = match child.wait() {
        Ok(s) => s,
        Err(_) => {
            report("exit 0", alone(me));
            return 0;
        }
    };
    let what = match (status.code(), status.signal()) {
        (Some(c), _) => format!("exit {c}"),
        (None, Some(s)) => format!("signal {s}"),
        (None, None) => "exit 0".to_string(),
    };
    let alone_now = alone(me);
    report(&what, alone_now);
    if !alone_now {
        // Guardian: hold the lifeline until everything the command left
        // behind is gone (or the lifeline breaks and takes the group down).
        while !alone(me) {
            std::thread::sleep(GUARD_POLL);
        }
    }
    0
}

fn report(what: &str, alone: bool) {
    let line = format!("{what} {}\n", if alone { "alone" } else { "linger" });
    let _ = sys::write_raw(RUNNER_STATUS_FD, line.as_bytes());
}

/// No member of our group but us. If the group cannot be enumerated the
/// runner cannot guard it, so it says "alone" and lets the daemon's own
/// group probe take over rather than spin here forever.
fn alone(me: u32) -> bool {
    match sys::group_members(me) {
        Ok(pids) => pids.iter().all(|p| *p == me),
        Err(_) => true,
    }
}

fn watch_lifeline(me: u32) {
    let mut buf = [0u8; 64];
    loop {
        match sys::read_raw(RUNNER_LIFELINE_FD, &mut buf) {
            Ok(0) => break,
            Ok(_) => continue, // nobody writes; ignore
            Err(_) => break,
        }
    }
    // The daemon is gone: take the group down. SIGTERM reaches everyone
    // but us (we block it).
    let _ = sys::signal_group(me, sys::SIGTERM);
    std::thread::sleep(LIFELINE_GRACE);
    // Then SIGKILL every other member, one by one, until we are alone: a
    // process forked while a group signal is delivered can miss it.
    for _ in 0..200 {
        let others: Vec<u32> = match sys::group_members(me) {
            Ok(pids) => pids.into_iter().filter(|p| *p != me).collect(),
            Err(_) => {
                let _ = sys::signal_group(me, sys::SIGKILL);
                break;
            }
        };
        if others.is_empty() {
            break;
        }
        for p in others {
            let _ = sys::kill_pid(p, sys::SIGKILL);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    std::process::exit(137);
}

/// Parsed status line. `None` for anything malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// The command left other processes in the group.
    pub linger: bool,
}

pub fn parse_status(line: &str) -> Option<Reported> {
    let mut it = line.split_whitespace();
    let kind = it.next()?;
    let n: i32 = it.next()?.parse().ok()?;
    let linger = match it.next()? {
        "alone" => false,
        "linger" => true,
        _ => return None,
    };
    match kind {
        "exit" => Some(Reported { code: Some(n), signal: None, linger }),
        "signal" => Some(Reported { code: None, signal: Some(n), linger }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines() {
        assert_eq!(parse_status("exit 3 alone\n"), Some(Reported { code: Some(3), signal: None, linger: false }));
        assert_eq!(parse_status("signal 9 linger"), Some(Reported { code: None, signal: Some(9), linger: true }));
        assert_eq!(parse_status("exit x alone"), None);
        assert_eq!(parse_status("exit 1"), None);
        assert_eq!(parse_status("boom 1 alone"), None);
    }
}
