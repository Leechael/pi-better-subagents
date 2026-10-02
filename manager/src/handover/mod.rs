//! In-place upgrade (design doc §3.2).
//!
//! Unix: `exec` the new binary while keeping the same pid and inherited fds.
//! Windows: not supported — clients must restart the manager after replacing
//! the binary (there is no same-pid `exec`).

#[cfg(windows)]
use crate::daemon::Shared;
#[cfg(windows)]
use crate::proto::*;
use std::path::{Path, PathBuf};

/// Version of `handover.json` and the fd contract. The new binary must
/// speak it (`__handover-check`).
pub const FORMAT: u32 = 1;
/// Hidden subcommand answering the preflight.
pub const CHECK_ARG: &str = "__handover-check";
pub(crate) const CHECK_PREFIX: &str = "pi-famulus-handover";

/// This daemon's executable path. Linux reports a replaced binary as
/// "<path> (deleted)"; the upgrade wants the file now at `<path>`.
/// Only strip that kernel marker (not a legitimate path that ends the same).
pub fn exe_path() -> std::io::Result<PathBuf> {
    let p = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    {
        let s = p.to_string_lossy();
        // procfs appends " (deleted)" when the inode is gone; require the
        // path still to have looked like an absolute executable path before.
        if let Some(orig) = s.strip_suffix(" (deleted)") {
            if orig.starts_with('/') && !orig.is_empty() {
                return Ok(PathBuf::from(orig));
            }
        }
    }
    Ok(p)
}

pub fn check_line() -> String {
    format!("{CHECK_PREFIX} {FORMAT} {}", crate::VERSION)
}

pub fn file_path(home: &Path) -> PathBuf {
    home.join("handover.json")
}

/// A preflighted upgrade, waiting for the accept loop.
pub struct Ready {
    pub exe: PathBuf,
    pub to_version: String,
    pub trigger: String,
}

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

/// Record that an upgrade was requested on a platform that cannot do it.
#[cfg(windows)]
pub fn fail_unsupported(state: &Shared, ready: Ready) -> String {
    let from = crate::VERSION.to_string();
    let msg = "in-place upgrade is not supported on Windows".to_string();
    let mut st = state.lock().unwrap();
    crate::lifecycle::log_line(&st.home, &format!("upgrade failed ({}): {msg}", ready.trigger));
    st.last_upgrade = Some(UpgradeInfo {
        at: now_ms(),
        ok: false,
        from_version: from,
        to_version: Some(ready.to_version),
        error: Some(msg.clone()),
        trigger: ready.trigger,
    });
    st.upgrade_pending = false;
    msg
}

#[cfg(windows)]
pub fn request(_state: &Shared, _trigger: &str) -> bool {
    false
}
