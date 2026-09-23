//! Shared black-box scaffolding for the adversarial lifecycle suites.
//!
//! Everything here talks to the compiled `pbs-manager` binary over its unix
//! socket (u32 BE length + JSON, design doc §3.3). Nothing links against the
//! crate's internals; `serde_json` and `libc` are already regular dependencies
//! of the package, so integration tests can use them without new
//! dev-dependencies.
//!
//! Determinism rules used throughout:
//! - every wait is a poll against a deadline (`poll_until`), never a bare sleep
//!   that the assertion depends on;
//! - the only fixed sleeps are "hold still for N seconds, then assert nothing
//!   happened" checks, where the passage of time *is* the thing under test.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub const BIN: &str = env!("CARGO_BIN_EXE_pbs-manager");
pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub const PATH_ENV: &str = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/// Poll `f` every 25ms until it returns Some or `timeout` elapses.
pub fn poll_until<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn poll_true(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    poll_until(timeout, || if f() { Some(()) } else { None }).is_some()
}

// ---------------------------------------------------------------------------
// Isolated home
// ---------------------------------------------------------------------------

/// Isolated `--home`. Short path on purpose: unix socket paths are limited to
/// ~104 bytes on Darwin. On drop: SIGKILL every process group the daemon ever
/// recorded, SIGKILL the daemon from manager.pid, remove the directory.
pub struct Home {
    pub path: PathBuf,
    /// Extra pids (e.g. grandchildren) the test learned about.
    pub extra_pids: Vec<u32>,
}

impl Home {
    pub fn new(name: &str) -> Home {
        let path = std::env::temp_dir().join(format!("pbsx-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test home");
        Home {
            path,
            extra_pids: Vec::new(),
        }
    }
    pub fn sock(&self) -> PathBuf {
        self.path.join("manager.sock")
    }
    pub fn pidfile(&self) -> PathBuf {
        self.path.join("manager.pid")
    }
    pub fn pidfile_pid(&self) -> Option<u32> {
        let v: Value = serde_json::from_slice(&fs::read(self.pidfile()).ok()?).ok()?;
        v.get("pid")?.as_u64().map(|p| p as u32)
    }
    /// Every TaskRecord on disk (any session).
    pub fn records(&self) -> Vec<Value> {
        let mut out = Vec::new();
        let Ok(sessions) = fs::read_dir(self.path.join("sessions")) else {
            return out;
        };
        for s in sessions.flatten() {
            let Ok(tasks) = fs::read_dir(s.path().join("tasks")) else {
                continue;
            };
            for t in tasks.flatten() {
                let p = t.path();
                if p.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(v) = serde_json::from_slice::<Value>(&fs::read(&p).unwrap_or_default()) {
                        out.push(v);
                    }
                }
            }
        }
        out
    }
    pub fn record(&self, task_id: &str) -> Option<Value> {
        self.records()
            .into_iter()
            .find(|r| r["task_id"].as_str() == Some(task_id))
    }
    /// Spawn `pbs-manager --home H daemon` as a direct child of the test.
    pub fn spawn_daemon(&self) -> Child {
        Command::new(BIN)
            .arg("--home")
            .arg(&self.path)
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon")
    }
    /// Spawn a daemon and wait until it accepts connections.
    pub fn start_daemon(&self) -> Child {
        let child = self.spawn_daemon();
        assert!(
            poll_true(Duration::from_secs(3), || UnixStream::connect(self.sock()).is_ok()),
            "daemon did not start listening within 3s"
        );
        child
    }
    pub fn connect(&self) -> Conn {
        let s = poll_until(Duration::from_secs(3), || UnixStream::connect(self.sock()).ok())
            .expect("connect to manager.sock");
        Conn::new(s)
    }
    /// Run a CLI subcommand with a hard deadline.
    pub fn cli(&self, args: &[&str], timeout: Duration) -> CliOut {
        run_cli(&self.path, args, timeout)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        for r in self.records() {
            if let Some(pid) = r["pid"].as_u64() {
                kill_group(pid as u32, libc::SIGKILL);
            }
        }
        for p in &self.extra_pids {
            kill_pid(*p, libc::SIGKILL);
        }
        if let Some(pid) = self.pidfile_pid() {
            kill_pid(pid, libc::SIGKILL);
        }
        for pid in daemon_pids_for(&self.path) {
            kill_pid(pid, libc::SIGKILL);
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub struct CliOut {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_cli(home: &Path, args: &[&str], timeout: Duration) -> CliOut {
    let mut child = Command::new(BIN)
        .arg("--home")
        .arg(home)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn cli");
    let status = wait_child(&mut child, timeout);
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        panic!("cli {args:?} did not finish within {timeout:?}");
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    child.stdout.take().unwrap().read_to_string(&mut stdout).ok();
    child.stderr.take().unwrap().read_to_string(&mut stderr).ok();
    CliOut {
        status,
        stdout,
        stderr,
    }
}

pub fn wait_child(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    poll_until(timeout, || child.try_wait().ok().flatten())
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/// kill(pid, 0); EPERM counts as alive. Zombies count as alive too, so callers
/// that own the child must reap it (test-owned daemons are reaped via
/// `wait_child`; task processes are children of the daemon, not of the test).
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Like `pid_alive` but a zombie (exited, not yet reaped by its parent)
/// counts as dead. Grandchildren re-parented to init get reaped promptly, but
/// on macOS `ps` is the only portable way to see the Z state.
pub fn pid_running(pid: u32) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output();
    match out {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout);
            let s = s.trim();
            !s.is_empty() && !s.starts_with('Z')
        }
        Err(_) => true,
    }
}

pub fn kill_pid(pid: u32, sig: i32) {
    if pid > 1 {
        unsafe {
            libc::kill(pid as i32, sig);
        }
    }
}

pub fn kill_group(pid: u32, sig: i32) {
    if pid > 1 {
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }
}

/// Resident set size of `pid` in bytes (via `ps -o rss=`, KiB on Darwin+Linux).
pub fn rss_bytes(pid: u32) -> Option<u64> {
    let o = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&o.stdout)
        .trim()
        .parse::<u64>()
        .ok()
        .map(|kib| kib * 1024)
}

/// Pids of `pbs-manager ... daemon` processes whose command line names `home`
/// (i.e. daemons auto-spawned by a CLI client with `--home <home>`).
pub fn daemon_pids_for(home: &Path) -> Vec<u32> {
    let Ok(o) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    let home_s = home.to_string_lossy().to_string();
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let (pid, cmd) = l.split_once(' ')?;
            let cmd = cmd.trim();
            // Exact token match: "pbsx-1-d1" must not match "pbsx-1-d15".
            let words: Vec<&str> = cmd.split_whitespace().collect();
            if cmd.contains("pbs-manager")
                && words.iter().any(|w| *w == home_s)
                && words.iter().any(|w| *w == "daemon")
            {
                let pid: u32 = pid.parse().ok()?;
                if pid_running(pid) {
                    return Some(pid);
                }
            }
            None
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Wire connection
// ---------------------------------------------------------------------------

pub enum Recv {
    Frame(Value),
    Timeout,
    Closed,
}

pub struct Conn {
    pub stream: UnixStream,
    buf: Vec<u8>,
    /// Frames read while waiting for something else (events, other ids).
    pub pending: VecDeque<Value>,
    /// Every event ever seen on this connection.
    pub events: Vec<Value>,
    next_id: u64,
    pub closed: bool,
}

impl Conn {
    pub fn new(stream: UnixStream) -> Conn {
        Conn {
            stream,
            buf: Vec::new(),
            pending: VecDeque::new(),
            events: Vec::new(),
            next_id: 0,
            closed: false,
        }
    }

    pub fn send_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(bytes)?;
        self.stream.flush()
    }

    pub fn send(&mut self, v: &Value) {
        let body = serde_json::to_vec(v).unwrap();
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        self.send_raw(&frame).expect("write frame");
    }

    /// Read one frame from the socket before `deadline`.
    pub fn recv(&mut self, deadline: Instant) -> Recv {
        loop {
            if self.buf.len() >= 4 {
                let n = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
                    as usize;
                if self.buf.len() >= 4 + n {
                    let body: Vec<u8> = self.buf.drain(..4 + n).skip(4).collect();
                    let v: Value = serde_json::from_slice(&body).unwrap_or_else(|e| {
                        panic!("daemon sent non-JSON frame ({e}): {:?}", String::from_utf8_lossy(&body[..body.len().min(200)]))
                    });
                    if v["type"] == "event" {
                        self.events.push(v.clone());
                    }
                    return Recv::Frame(v);
                }
            }
            if self.closed {
                return Recv::Closed;
            }
            let now = Instant::now();
            if now >= deadline {
                return Recv::Timeout;
            }
            self.stream
                .set_read_timeout(Some((deadline - now).min(Duration::from_millis(100))))
                .ok();
            let mut chunk = vec![0u8; 64 * 1024];
            match self.stream.read(&mut chunk) {
                Ok(0) => self.closed = true,
                Ok(k) => self.buf.extend_from_slice(&chunk[..k]),
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => self.closed = true,
            }
        }
    }

    /// Send `req` with a fresh id; return the response echoing it (or None on
    /// timeout / close). Other frames are kept in `pending`.
    pub fn try_request(&mut self, mut req: Value, timeout: Duration) -> Option<Value> {
        self.next_id += 1;
        let id = format!("q{}", self.next_id);
        req["v"] = json!(1);
        req["id"] = json!(id);
        self.send(&req);
        if let Some(pos) = self.pending.iter().position(|f| f["id"] == json!(id)) {
            return self.pending.remove(pos);
        }
        let deadline = Instant::now() + timeout;
        loop {
            match self.recv(deadline) {
                Recv::Frame(f) => {
                    if f["id"] == json!(id) {
                        return Some(f);
                    }
                    self.pending.push_back(f);
                }
                Recv::Timeout | Recv::Closed => return None,
            }
        }
    }

    /// Wait for the response with a caller-chosen id (for raw-sent frames).
    /// Responses to pipelined requests may arrive in any order.
    pub fn wait_id(&mut self, id: &str, timeout: Duration) -> Option<Value> {
        if let Some(pos) = self.pending.iter().position(|f| f["id"] == json!(id)) {
            return self.pending.remove(pos);
        }
        let deadline = Instant::now() + timeout;
        loop {
            match self.recv(deadline) {
                Recv::Frame(f) if f["id"] == json!(id) => return Some(f),
                Recv::Frame(f) => self.pending.push_back(f),
                Recv::Timeout | Recv::Closed => return None,
            }
        }
    }

    pub fn request(&mut self, req: Value) -> Value {
        let r = self.try_request(req.clone(), Duration::from_secs(10));
        r.unwrap_or_else(|| panic!("no response to {req} within 10s (closed={})", self.closed))
    }

    pub fn request_ok(&mut self, req: Value) -> Value {
        let r = self.request(req.clone());
        assert_eq!(r["ok"], json!(true), "request {req} failed: {r}");
        r
    }

    pub fn hello_ext(&mut self, session: &str) -> Value {
        self.request(json!({"type":"hello","client_kind":"extension","session_id":session,"pi_pid":std::process::id()}))
    }

    pub fn hello(&mut self, req: Value) -> Value {
        self.request_ok(req)
    }

    pub fn hello_cli(&mut self) -> Value {
        self.request(json!({"type":"hello","client_kind":"cli"}))
    }

    /// Start a shell task; returns (task_id, pid).
    pub fn start(&mut self, command: &str) -> (String, u32) {
        self.start_with(json!({"type":"start","kind":"shell","command":command,"cwd":"/tmp",
            "env":{"PATH":PATH_ENV},"run_in_background":true}))
    }

    pub fn start_with(&mut self, req: Value) -> (String, u32) {
        let r = self.request_ok(req);
        (
            r["task_id"].as_str().unwrap().to_string(),
            r["pid"].as_u64().unwrap() as u32,
        )
    }

    /// Wait for an event matching `pred`, looking at already-seen events first.
    pub fn wait_event(&mut self, timeout: Duration, pred: impl Fn(&Value) -> bool) -> Option<Value> {
        if let Some(e) = self.events.iter().find(|e| pred(e)) {
            return Some(e.clone());
        }
        let deadline = Instant::now() + timeout;
        loop {
            match self.recv(deadline) {
                Recv::Frame(f) => {
                    if f["type"] == "event" && pred(&f) {
                        return Some(f);
                    }
                    if f["type"] != "event" {
                        self.pending.push_back(f);
                    }
                }
                Recv::Timeout | Recv::Closed => return None,
            }
        }
    }

    /// Drain frames until the peer closes; true if it closed before timeout.
    pub fn wait_closed(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            match self.recv(deadline) {
                Recv::Frame(f) => {
                    if f["type"] != "event" {
                        self.pending.push_back(f);
                    }
                }
                Recv::Closed => return true,
                Recv::Timeout => return false,
            }
        }
    }

    pub fn task(&mut self, task_id: &str) -> Option<Value> {
        let r = self.request_ok(json!({"type":"list","all":true}));
        r["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["task_id"] == json!(task_id))
            .cloned()
    }

    pub fn status_of(&mut self, task_id: &str) -> Option<String> {
        self.task(task_id)
            .and_then(|t| t["status"].as_str().map(|s| s.to_string()))
    }

    /// Poll `list` until `task_id` reaches a terminal status; returns the record.
    pub fn wait_terminal(&mut self, task_id: &str, timeout: Duration) -> Option<Value> {
        poll_until(timeout, || {
            let t = self.task(task_id)?;
            if t["status"] != "running" {
                Some(t)
            } else {
                None
            }
        })
    }

    /// Read the full output via cursor loop until caught up and terminal.
    pub fn read_all_output(&mut self, task_id: &str, max_bytes: u64) -> (String, u64, Value) {
        let mut cursor = 0u64;
        let mut text = String::new();
        let mut last;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            last = self.request_ok(json!({"type":"output","task_id":task_id,"cursor":cursor,"max_bytes":max_bytes}));
            let chunk = last["chunk"].as_str().unwrap();
            text.push_str(chunk);
            let next = last["next_cursor"].as_u64().unwrap();
            let total = last["total_size"].as_u64().unwrap();
            if next == cursor && last["status"] != "running" && next >= total {
                break;
            }
            if next == cursor {
                std::thread::sleep(Duration::from_millis(20));
            }
            cursor = next;
            assert!(Instant::now() < deadline, "output loop did not catch up");
        }
        (text, cursor, last)
    }
}

// ---------------------------------------------------------------------------
// Helper client process (a real "pi" stand-in that can be kill -9'd)
// ---------------------------------------------------------------------------

/// A separate OS process holding one extension connection. It is this same
/// test binary re-executed to run the `helper_hold_extension_conn` entry
/// point (see lifecycle_adversarial.rs). Killing it with SIGKILL is exactly
/// the "pi crashed" event: the kernel closes the socket.
pub struct HelperClient {
    pub child: Child,
    pub tasks: Vec<(String, u32)>,
    pub lines: Vec<String>,
    _stdout: BufReader<ChildStdout>,
}

impl HelperClient {
    pub fn spawn(home: &Path, session: &str, commands: &[&str]) -> HelperClient {
        let exe = std::env::current_exe().unwrap();
        let mut child = Command::new(exe)
            .args([
                "--exact",
                "helper_hold_extension_conn",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PBSX_HELPER_HOME", home)
            .env("PBSX_HELPER_SESSION", session)
            .env("PBSX_HELPER_CMDS", commands.join("\n"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn helper client");
        let mut rd = BufReader::new(child.stdout.take().unwrap());
        let mut tasks = Vec::new();
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            let n = rd.read_line(&mut line).expect("helper stdout");
            assert!(n > 0, "helper exited before READY; lines={lines:?}");
            let line = line.trim().to_string();
            if let Some(i) = line.find("PBSX_TASK ") {
                let rest = &line[i + "PBSX_TASK ".len()..];
                let mut it = rest.split_whitespace();
                let id = it.next().unwrap().to_string();
                let pid: u32 = it.next().unwrap().parse().unwrap();
                tasks.push((id, pid));
            } else if line.contains("PBSX_READY") {
                break;
            }
            lines.push(line);
        }
        HelperClient {
            child,
            tasks,
            lines,
            _stdout: rd,
        }
    }

    /// SIGKILL the helper and reap it: the daemon sees an abrupt EOF.
    pub fn crash(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for HelperClient {
    fn drop(&mut self) {
        self.crash();
    }
}

/// Body of the helper process. Returns immediately unless re-exec'd by
/// `HelperClient::spawn`.
pub fn helper_main() {
    let Ok(home) = std::env::var("PBSX_HELPER_HOME") else {
        return;
    };
    let session = std::env::var("PBSX_HELPER_SESSION").unwrap();
    let cmds = std::env::var("PBSX_HELPER_CMDS").unwrap_or_default();
    let stream = UnixStream::connect(Path::new(&home).join("manager.sock")).expect("helper connect");
    let mut c = Conn::new(stream);
    let h = c.hello_ext(&session);
    assert_eq!(h["ok"], json!(true), "helper hello: {h}");
    let mut out = std::io::stdout();
    for cmd in cmds.split('\n').filter(|s| !s.is_empty()) {
        let (id, pid) = c.start(cmd);
        writeln!(out, "PBSX_TASK {id} {pid}").unwrap();
    }
    writeln!(out, "PBSX_READY").unwrap();
    out.flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Extract whitespace-separated integers printed by a task (e.g. `echo $!`).
pub fn pids_in(text: &str) -> Vec<u32> {
    text.split_whitespace()
        .filter_map(|w| w.parse::<u32>().ok())
        .collect()
}

/// Poll a task's output until it contains at least `n` integers (pids).
pub fn wait_for_pids(c: &mut Conn, task_id: &str, n: usize) -> Vec<u32> {
    poll_until(Duration::from_secs(5), || {
        let r = c.request_ok(json!({"type":"output","task_id":task_id,"cursor":0,"max_bytes":65536}));
        let p = pids_in(r["chunk"].as_str().unwrap_or(""));
        if p.len() >= n {
            Some(p)
        } else {
            None
        }
    })
    .unwrap_or_else(|| panic!("task {task_id} did not print {n} pids"))
}
