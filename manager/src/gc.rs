//! Retention for sessions that are gone (§3.2).
//!
//! A pi session's work leaves the listings (`ls`, `sessions`) as soon as the
//! session disconnects. Its files (task records and output, agent records and
//! transcripts, events.jsonl) stay on disk for `goneSessionRetention` (default
//! 24h) so `show`, `agent` and `events` still work for a post-mortem or after
//! `pi --resume`; then the daemon deletes `sessions/<sid>/` and forgets the
//! session's tasks. Sessions that are connected, or still own a running task
//! or a live process group, are never swept.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Default retention for a gone session's files.
pub const DEFAULT_RETENTION_MS: u64 = 24 * 3_600_000;
/// Sweep cadence bounds: short retentions are honoured within a second,
/// long ones are checked at least hourly.
const MIN_INTERVAL_MS: u64 = 1_000;
const MAX_INTERVAL_MS: u64 = 3_600_000;

/// `goneSessionRetention` from `<home>/config.json` ("24h", "30m", "0s"…).
/// Absent or unreadable config means the default; an invalid value is an
/// error so the caller can log it (and `doctor` can flag it).
pub fn retention_ms(home: &Path) -> Result<u64, String> {
    let raw = match fs::read(home.join("config.json")) {
        Ok(b) => b,
        Err(_) => return Ok(DEFAULT_RETENTION_MS),
    };
    let v: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(DEFAULT_RETENTION_MS), // doctor reports the parse error
    };
    match v.get("goneSessionRetention") {
        None | Some(serde_json::Value::Null) => Ok(DEFAULT_RETENTION_MS),
        Some(serde_json::Value::String(s)) => crate::fmt::parse_duration(s)
            .map_err(|e| format!("goneSessionRetention: {e}")),
        Some(other) => Err(format!(
            "goneSessionRetention must be a duration string such as \"24h\", got {other}"
        )),
    }
}

pub fn interval_ms(retention_ms: u64) -> u64 {
    retention_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS)
}

/// Newest mtime under a session directory (two levels: files and
/// tasks/ / agents/ contents), in epoch ms.
fn last_activity_ms(dir: &Path) -> u64 {
    fn mtime_ms(p: &Path) -> u64 {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
    let mut newest = mtime_ms(dir);
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            newest = newest.max(mtime_ms(&p));
            if p.is_dir() {
                if let Ok(inner) = fs::read_dir(&p) {
                    for f in inner.flatten() {
                        newest = newest.max(mtime_ms(&f.path()));
                    }
                }
            }
        }
    }
    newest
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Delete `sessions/<sid>/` for every session not in `keep` whose newest file
/// is older than `retention_ms`. Returns the removed session ids.
pub fn sweep(home: &Path, keep: &HashSet<String>, retention_ms: u64) -> Vec<String> {
    sweep_at(home, keep, retention_ms, now_ms())
}

pub fn sweep_at(home: &Path, keep: &HashSet<String>, retention_ms: u64, now: u64) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(dirs) = fs::read_dir(home.join("sessions")) else {
        return removed;
    };
    for d in dirs.flatten() {
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let sid = d.file_name().to_string_lossy().into_owned();
        if keep.contains(&sid) {
            continue;
        }
        if now.saturating_sub(last_activity_ms(&d.path())) < retention_ms {
            continue;
        }
        if fs::remove_dir_all(d.path()).is_ok() {
            removed.push(sid);
        }
    }
    removed.sort();
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> std::path::PathBuf {
        let h = std::env::temp_dir().join(format!("pbs-gc-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&h);
        fs::create_dir_all(h.join("sessions")).unwrap();
        h
    }

    fn session(h: &Path, sid: &str) {
        let d = h.join("sessions").join(sid);
        fs::create_dir_all(d.join("tasks")).unwrap();
        fs::write(d.join("tasks").join("sh_1.json"), "{}").unwrap();
        fs::write(d.join("events.jsonl"), "").unwrap();
    }

    #[test]
    fn sweeps_only_expired_sessions_outside_keep() {
        let h = home("sweep");
        session(&h, "gone-old");
        session(&h, "gone-fresh");
        session(&h, "connected");
        let keep: HashSet<String> = ["connected".to_string()].into();
        let now = now_ms();
        // Nothing is older than an hour yet.
        assert!(sweep_at(&h, &keep, 3_600_000, now).is_empty());
        // Two hours later both gone sessions expired; the kept one survives.
        let removed = sweep_at(&h, &keep, 3_600_000, now + 7_200_000);
        assert_eq!(removed, ["gone-fresh", "gone-old"]);
        assert!(h.join("sessions/connected").exists());
        assert!(!h.join("sessions/gone-old").exists());
        fs::remove_dir_all(&h).ok();
    }

    #[test]
    fn recent_activity_deep_in_the_dir_keeps_a_session() {
        let h = home("activity");
        session(&h, "s");
        let now = now_ms();
        // The dir itself looks old only if nothing inside was touched: a fresh
        // task file keeps it within a one-minute retention.
        assert!(sweep_at(&h, &HashSet::new(), 60_000, now).is_empty());
        assert_eq!(sweep_at(&h, &HashSet::new(), 60_000, now + 120_000), ["s"]);
        fs::remove_dir_all(&h).ok();
    }

    #[test]
    fn retention_config() {
        let h = home("config");
        assert_eq!(retention_ms(&h), Ok(DEFAULT_RETENTION_MS));
        fs::write(h.join("config.json"), r#"{"goneSessionRetention":"30m"}"#).unwrap();
        assert_eq!(retention_ms(&h), Ok(1_800_000));
        fs::write(h.join("config.json"), r#"{"goneSessionRetention":"0s"}"#).unwrap();
        assert_eq!(retention_ms(&h), Ok(0));
        fs::write(h.join("config.json"), r#"{"goneSessionRetention":"soon"}"#).unwrap();
        assert!(retention_ms(&h).is_err());
        fs::write(h.join("config.json"), r#"{"goneSessionRetention":5}"#).unwrap();
        assert!(retention_ms(&h).is_err());
        assert_eq!(interval_ms(0), 1_000);
        assert_eq!(interval_ms(DEFAULT_RETENTION_MS), 3_600_000);
        fs::remove_dir_all(&h).ok();
    }
}
