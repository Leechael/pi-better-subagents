//! `pbs-manager __run <command>`: the leader of every task's process group
//! (design doc §3.2 / §3.4).
//!
//! The daemon spawns this runner as a session leader instead of `sh -c`
//! directly. It starts with one extra descriptor, fd 3, the LIFELINE: the
//! read end of a pipe whose write end only the daemon holds. When the daemon
//! ends by any means (`shutdown`, `kill -9`, a panic), the kernel closes
//! that write end and this read returns EOF. The runner then SIGTERMs its
//! process group, waits the 2 s grace, and SIGKILLs it: no task outlives
//! its manager.
//!
//! The runner ends the way the command ended (same exit code, or the same
//! signal re-raised on itself), so the daemon's wait on the runner reads the
//! command's status.
//!
//! The runner blocks SIGTERM, so a group SIGTERM (stop, shutdown) reaches
//! the command while the runner lives to mirror how the command ended. The
//! child unblocks it right before exec. A handler would not do: a SIGTERM
//! landing between the fork and the exec of `sh` would run the inherited
//! handler in the child and be lost; blocked, it stays pending and acts the
//! moment the child unblocks it.

use crate::sys::{self, RUNNER_LIFELINE_FD};
use std::os::unix::process::ExitStatusExt;
use std::time::Duration;

/// Grace between the group SIGTERM and SIGKILL when the lifeline breaks
/// (the same 2 s as the daemon's stop/shutdown, §3.2).
const LIFELINE_GRACE: Duration = Duration::from_secs(2);

pub fn main(command: &str) -> i32 {
    // The lifeline must not reach the command.
    let _ = sys::set_cloexec(RUNNER_LIFELINE_FD);
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
            return 127;
        }
    };
    // A group SIGTERM (an early stop) that reached only us, before `sh`
    // existed, is pending here: pass it on now that `sh` is in the group.
    // If `sh` got it too, a second SIGTERM changes nothing.
    if sys::signal_pending(libc::SIGTERM) {
        let _ = sys::signal_group(me, sys::SIGTERM);
    }
    match child.wait() {
        Ok(s) => match (s.code(), s.signal()) {
            (Some(c), _) => c,
            (None, Some(sig)) => sys::die_by_signal(sig),
            (None, None) => 0,
        },
        Err(_) => 0,
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
    // The daemon is gone: take the group down, ourselves included.
    let _ = sys::signal_group(me, sys::SIGTERM);
    std::thread::sleep(LIFELINE_GRACE);
    let _ = sys::signal_group(me, sys::SIGKILL);
}
