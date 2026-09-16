//! Singleton & startup lifecycle (design doc §3.1, §3.2): base dir resolution,
//! pid claim, spawn lock, zombie cleanup, and re-adopt scanning on restart.

use crate::proto::{now_ms, TaskStatus};
use crate::registry::{self, Registry, TaskEntry};
use crate::task;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Base directory & well-known paths (§3.1)
// ---------------------------------------------------------------------------

/// Priority: --home flag > PBS_HOME env > ~/.pi/agent/pbs.
pub fn resolve_home(flag: Option<&Path>) -> PathBuf {
    if let Some(p) = flag {
        return p.to_path_buf();
    }
    if let Some(env) = std::env::var_os("PBS_HOME") {
        if !env.is_empty() {
            return PathBuf::from(env);
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".pi").join("agent").join("pbs")
}

pub fn socket_path(home: &Path) -> PathBuf {
    home.join("manager.sock")
}

pub fn pid_path(home: &Path) -> PathBuf {
    home.join("manager.pid")
}

pub fn lock_path(home: &Path) -> PathBuf {
    home.join("manager.spawn.lock")
}

pub fn log_path(home: &Path) -> PathBuf {
    home.join("manager.log")
}

/// Append one line to manager.log (best effort; never fails the caller).
pub fn log_line(home: &Path, msg: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path(home)) {
        let _ = writeln!(f, "[{}] {msg}", now_ms());
    }
}

// ---------------------------------------------------------------------------
// Pid file & daemon claim (§3.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PidFile {
    pub pid: u32,
    pub version: String,
    pub started_at: u64,
}

pub fn read_pid_file(home: &Path) -> Option<PidFile> {
    let bytes = fs::read(pid_path(home)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_pid_file(home: &Path, pid: u32) -> io::Result<()> {
    let pf = PidFile {
        pid,
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: now_ms(),
    };
    let tmp = home.join("manager.pid.tmp");
    fs::write(&tmp, serde_json::to_vec(&pf).map_err(io::Error::other)?)?;
    fs::rename(&tmp, pid_path(home))?;
    Ok(())
}

/// Remove socket + pid files (stale after a dead manager, or at shutdown).
pub fn cleanup_stale_files(home: &Path) -> io::Result<()> {
    for p in [socket_path(home), pid_path(home)] {
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub enum Claim {
    Acquired,
    AlreadyRunning { pid: u32 },
}

/// §3.1: daemon startup checks the pid file first — a live pid refuses the
/// start ("already running", exit 0); a dead pid is cleaned up and taken over.
pub fn claim_pid(home: &Path) -> io::Result<Claim> {
    if let Some(pf) = read_pid_file(home) {
        if task::pid_alive(pf.pid) {
            return Ok(Claim::AlreadyRunning { pid: pf.pid });
        }
        cleanup_stale_files(home)?;
    } else if socket_path(home).exists() {
        // Socket without a pid file is a zombie; remove it.
        cleanup_stale_files(home)?;
    }
    Ok(Claim::Acquired)
}

// ---------------------------------------------------------------------------
// Spawn lock (client side, §3.1 step 2)
// ---------------------------------------------------------------------------

/// Guard for the fd-lock on manager.spawn.lock. The underlying lock object is
/// leaked so the guard can be returned; a CLI process holds it for seconds at
/// most and the OS releases the lock on exit anyway.
pub struct SpawnLockGuard {
    _guard: fd_lock::RwLockWriteGuard<'static, std::fs::File>,
}

/// Non-blocking trylock. Ok(None) = someone else is spawning right now.
pub fn try_acquire_spawn_lock(home: &Path) -> io::Result<Option<SpawnLockGuard>> {
    let f = OpenOptions::new()
        .create(true)
        .write(true)
        .open(lock_path(home))?;
    let lock: &'static mut fd_lock::RwLock<std::fs::File> =
        Box::leak(Box::new(fd_lock::RwLock::new(f)));
    match lock.try_write() {
        Ok(guard) => Ok(Some(SpawnLockGuard { _guard: guard })),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Re-adopt scan on manager restart (§3.4)
// ---------------------------------------------------------------------------

pub struct ScanResult {
    /// (task_id, pid) of tasks whose process is still alive -> re-adopt.
    pub readopted: Vec<(String, u32)>,
    /// Running tasks whose process is dead -> marked orphaned.
    pub orphaned: usize,
    /// Already-terminal records loaded for list/output visibility.
    pub loaded: usize,
}

pub fn scan_tasks(home: &Path, registry: &mut Registry) -> ScanResult {
    let mut result = ScanResult {
        readopted: Vec::new(),
        orphaned: 0,
        loaded: 0,
    };
    for mut rec in registry::load_all_records(home) {
        if rec.status == TaskStatus::Running {
            if task::pid_alive(rec.pid) {
                // §3.4: pid alive -> re-adopt; output file keeps being tailed.
                result.readopted.push((rec.task_id.clone(), rec.pid));
                registry.tasks.insert(rec.task_id.clone(), TaskEntry::adopted(rec));
            } else {
                // §3.4: pid dead -> orphaned.
                rec.status = TaskStatus::Orphaned;
                rec.ended_at = Some(now_ms());
                let _ = registry::persist_record(home, &rec);
                registry.tasks.insert(rec.task_id.clone(), TaskEntry::terminal(rec));
                result.orphaned += 1;
            }
        } else {
            registry.tasks.insert(rec.task_id.clone(), TaskEntry::terminal(rec));
            result.loaded += 1;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pbs-lc-test-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn home_resolution_priority() {
        // flag wins over everything (§3.1).
        let flag = PathBuf::from("/tmp/pbs-flag");
        assert_eq!(resolve_home(Some(&flag)), flag);
        // env beats the default.
        std::env::set_var("PBS_HOME", "/tmp/pbs-env");
        assert_eq!(resolve_home(None), PathBuf::from("/tmp/pbs-env"));
        std::env::remove_var("PBS_HOME");
        // default: ~/.pi/agent/pbs
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        assert_eq!(resolve_home(None), home.join(".pi/agent/pbs"));
    }

    #[test]
    fn claim_refuses_live_pid_and_takes_over_dead() {
        let home = temp_home("claim");
        // Live pid (ourselves) -> already running.
        write_pid_file(&home, std::process::id()).unwrap();
        match claim_pid(&home).unwrap() {
            Claim::AlreadyRunning { pid } => assert_eq!(pid, std::process::id()),
            Claim::Acquired => panic!("should have refused"),
        }
        // Dead pid -> cleaned up and acquired.
        write_pid_file(&home, 99_999_999).unwrap();
        fs::write(socket_path(&home), b"").unwrap();
        match claim_pid(&home).unwrap() {
            Claim::Acquired => {}
            Claim::AlreadyRunning { .. } => panic!("should have taken over"),
        }
        assert!(!pid_path(&home).exists());
        assert!(!socket_path(&home).exists());
        // Zombie socket without pid file -> cleaned.
        fs::write(socket_path(&home), b"").unwrap();
        match claim_pid(&home).unwrap() {
            Claim::Acquired => {}
            Claim::AlreadyRunning { .. } => panic!("should have taken over"),
        }
        assert!(!socket_path(&home).exists());
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn scan_marks_dead_running_tasks_orphaned() {
        let home = temp_home("scan");
        let rec = crate::proto::TaskRecord {
            task_id: "sh_0000000a".into(),
            session_id: "s1".into(),
            kind: crate::proto::TaskKind::Shell,
            command: "sleep 1".into(),
            cwd: "/tmp".into(),
            pid: 99_999_999, // dead
            status: TaskStatus::Running,
            exit_code: None,
            signal: None,
            started_at: now_ms(),
            ended_at: None,
            output_path: registry::task_output_path(&home, "s1", "sh_0000000a")
                .to_string_lossy()
                .into_owned(),
            output_size: 3,
        };
        registry::persist_record(&home, &rec).unwrap();
        let mut reg = Registry::new(home.clone());
        let res = scan_tasks(&home, &mut reg);
        assert_eq!(res.orphaned, 1);
        assert!(res.readopted.is_empty());
        let e = &reg.tasks["sh_0000000a"];
        assert_eq!(e.record.status, TaskStatus::Orphaned);
        assert!(e.record.ended_at.is_some());
        // Persisted too.
        let loaded = registry::load_all_records(&home);
        assert_eq!(loaded[0].status, TaskStatus::Orphaned);
        std::fs::remove_dir_all(&home).ok();
    }
}
