//! CLI client (design doc §3.1 startup flow, §3.5 subcommands).
//! Every subcommand except `daemon`/`doctor`/`log` is a short-lived socket
//! client: connect -> hello -> one request -> response -> close.
//! (`output -f` and `log -f` are the long-lived exceptions.)

use crate::lifecycle;
use crate::proto::*;
use crate::task;
use interprocess::local_socket::tokio::prelude::*; // trait for Stream::connect
use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::{GenericFilePath, ToFsName};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{ReadHalf, WriteHalf};

/// How this client presents itself in the hello handshake (§3.3).
pub enum HelloMode {
    Cli,
    /// CLI `start` needs a session to own the task (start is session-bound).
    Extension { session_id: String },
}

pub struct Conn {
    rd: ReadHalf<Stream>,
    wr: WriteHalf<Stream>,
}

impl Conn {
    /// Send one request, wait for its matching response (events and other
    /// frames are skipped — a short-lived CLI has no event consumer).
    pub async fn roundtrip<T: DeserializeOwned>(&mut self, kind: RequestKind) -> Result<T, String> {
        let id = new_request_id();
        let req = Request {
            v: Some(PROTO_VERSION),
            id: id.clone(),
            kind,
        };
        write_frame(&mut self.wr, &encode(&req))
            .await
            .map_err(|e| format!("send: {e}"))?;
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(30), read_frame(&mut self.rd))
                .await
                .map_err(|_| "response timed out".to_string())?
                .map_err(|e| format!("recv: {e}"))?
                .ok_or_else(|| "manager closed the connection".to_string())?;
            let v: serde_json::Value =
                serde_json::from_slice(&frame).map_err(|e| format!("bad response JSON: {e}"))?;
            if v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()) {
                continue; // event or unrelated frame
            }
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                let resp: Response<T> = serde_json::from_value(v)
                    .map_err(|e| format!("bad response payload: {e}"))?;
                return Ok(resp.body);
            }
            let err: Response<ErrorBody> =
                serde_json::from_value(v).map_err(|e| format!("bad error payload: {e}"))?;
            return Err(format!("{}: {}", err.body.error.code, err.body.error.message));
        }
    }
}

// ---------------------------------------------------------------------------
// Connect + spawn flow (§3.1)
// ---------------------------------------------------------------------------

async fn try_connect_and_hello(home: &Path, mode: &HelloMode) -> Result<Conn, String> {
    let sock = lifecycle::socket_path(home);
    let name = sock
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .map_err(|e| format!("bad socket path: {e}"))?;
    let stream = Stream::connect(name)
        .await
        .map_err(|e| format!("connect {}: {e}", sock.display()))?;
    let (rd, wr) = tokio::io::split(stream);
    let mut conn = Conn { rd, wr };
    let hello = match mode {
        HelloMode::Cli => RequestKind::Hello {
            client_kind: ClientKind::Cli,
            session_id: None,
            pi_pid: None,
            cwd: None,
            extension_version: None,
            protocol: Some(PROTOCOL),
        },
        HelloMode::Extension { session_id } => RequestKind::Hello {
            client_kind: ClientKind::Extension,
            session_id: Some(session_id.clone()),
            pi_pid: Some(std::process::id()),
            cwd: std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()),
            extension_version: Some(format!("pbs-manager-cli/{}", env!("CARGO_PKG_VERSION"))),
            protocol: Some(PROTOCOL),
        },
    };
    let _: HelloOk = conn.roundtrip(hello).await?;
    Ok(conn)
}

async fn wait_for_socket(home: &Path, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let sock = lifecycle::socket_path(home);
        if let Ok(name) = sock.as_os_str().to_fs_name::<GenericFilePath>() {
            if Stream::connect(name).await.is_ok() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// Spawn `pbs-manager daemon` detached (own session, output to manager.log)
/// so it outlives this short-lived CLI process (§3.1 step 3).
fn spawn_daemon(home: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(lifecycle::log_path(home))
        .map_err(|e| format!("open manager.log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--home")
        .arg(home)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    crate::sys::apply_new_session_std(&mut cmd);
    cmd.spawn().map_err(|e| format!("spawn daemon: {e}"))?;
    Ok(())
}

/// §3.1 client startup flow: connect; on failure take the spawn lock and
/// spawn (or wait for the in-progress spawn), then retry once. A zombie
/// socket is handled the same way: the spawned daemon, holding manager.lock,
/// removes it.
pub async fn connect(home: &Path, mode: &HelloMode) -> Result<Conn, String> {
    let mut last_err = String::new();
    for attempt in 0..2 {
        match try_connect_and_hello(home, mode).await {
            Ok(c) => return Ok(c),
            Err(e) => last_err = e,
        }
        if attempt > 0 {
            break;
        }
        // Clients never delete socket/pid files: only the daemon holding
        // manager.lock may (§3.1). A client cleaning up here could unlink the
        // socket of a daemon another client just spawned.
        // Steps 2–4: spawn lock; winner spawns, losers wait for the socket.
        match lifecycle::try_acquire_spawn_lock(home) {
            Ok(Some(guard)) => {
                spawn_daemon(home)?;
                let ok = wait_for_socket(home, Duration::from_secs(2)).await;
                drop(guard); // release the spawn lock (§3.1 step 3)
                if !ok {
                    last_err = "spawned daemon did not create its socket within 2s".into();
                }
            }
            Ok(None) => {
                // Someone else is spawning; just wait.
                if !wait_for_socket(home, Duration::from_secs(2)).await {
                    last_err = "another client is spawning the manager, but it did not come up".into();
                }
            }
            Err(e) => last_err = format!("spawn lock: {e}"),
        }
    }
    Err(format!("cannot reach pbs-manager: {last_err}"))
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

pub async fn cmd_status(home: &Path) -> Result<(), String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let st: StatusOk = conn.roundtrip(RequestKind::Status).await?;
    println!("version:  {}", st.version);
    println!("pid:      {}", st.pid);
    println!("uptime:   {}.{:03}s", st.uptime_ms / 1000, st.uptime_ms % 1000);
    println!("sessions: {} ({} connected)", st.sessions.len(), st.sessions.iter().filter(|s| s.connected).count());
    println!("tasks:    {} running, {} terminal", st.task_counts.running, st.task_counts.terminal);
    Ok(())
}

pub async fn cmd_sessions(home: &Path) -> Result<(), String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let st: StatusOk = conn.roundtrip(RequestKind::Status).await?;
    if st.sessions.is_empty() {
        println!("no sessions");
        return Ok(());
    }
    println!("{:<36} {:>8} {:<9} CWD", "SESSION_ID", "PI_PID", "CONNECTED");
    for s in st.sessions {
        let cwd = s.cwd.as_deref().filter(|c| !c.is_empty()).unwrap_or("-");
        println!("{:<36} {:>8} {:<9} {}", s.session_id, s.pi_pid, s.connected, cwd);
    }
    Ok(())
}

pub async fn cmd_list(home: &Path, session: Option<String>, include_exited: bool) -> Result<(), String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let st: StatusOk = conn.roundtrip(RequestKind::Status).await?;
    let connected: HashSet<String> = st
        .sessions
        .iter()
        .filter(|s| s.connected)
        .map(|s| s.session_id.clone())
        .collect();
    // CLI is admin: with no --session filter the daemon returns every session.
    let res: ListOk = conn
        .roundtrip(RequestKind::List {
            all: true,
            session_id: session.clone(),
        })
        .await?;
    let agents = load_agent_records(home, session.as_deref(), &connected);
    let terminal_shells = res.tasks.iter().filter(|t| t.status.is_terminal()).count();
    let terminal_agents = agents
        .iter()
        .filter(|a| agent_status_terminal(&a.status))
        .count();
    let tasks: Vec<_> = res
        .tasks
        .into_iter()
        .filter(|t| include_exited || !t.status.is_terminal())
        .collect();
    let agents: Vec<_> = agents
        .into_iter()
        .filter(|a| include_exited || !agent_status_terminal(&a.status))
        .collect();
    if tasks.is_empty() && agents.is_empty() {
        let terminal = terminal_shells + terminal_agents;
        if include_exited {
            println!("no tasks");
        } else if terminal > 0 {
            println!(
                "no running tasks ({terminal} exited; use -a / --all to include them)"
            );
        } else {
            println!("no running tasks");
        }
        return Ok(());
    }
    println!("{}", ls_header());
    for t in &tasks {
        let kind = serde_json::to_string(&t.kind)
            .unwrap_or_else(|_| "shell".into())
            .trim_matches('"')
            .to_string();
        let status = serde_json::to_string(&t.status)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let exit = t
            .exit_code
            .map(|c| c.to_string())
            .or_else(|| t.signal.clone())
            .unwrap_or_else(|| "-".into());
        println!(
            "{}",
            format_ls_row(
                &t.task_id,
                &kind,
                &t.session_id,
                &status,
                &t.pid.to_string(),
                &exit,
                &t.output_size.to_string(),
                &truncate_command(&t.command, 60),
            )
        );
    }
    for a in &agents {
        let model = a
            .model
            .as_deref()
            .map(|m| format!(" {m}"))
            .unwrap_or_default();
        let cmd = format!("agent:{} ({}){model}", a.name, a.agent);
        println!(
            "{}",
            format_ls_row(
                &a.child_id,
                "agent",
                &a.session_id,
                &a.status,
                "-",
                "-",
                "-",
                &truncate_command(&cmd, 60),
            )
        );
    }
    Ok(())
}

/// `TASK_ID KIND SESSION STATUS PID EXIT SIZE COMMAND`
pub fn ls_header() -> String {
    format!(
        "{:<14} {:<8} {:<8} {:<10} {:>7} {:>7} {:>9} COMMAND",
        "TASK_ID", "KIND", "SESSION", "STATUS", "PID", "EXIT", "SIZE"
    )
}

pub fn format_ls_row(
    task_id: &str,
    kind: &str,
    session_id: &str,
    status: &str,
    pid: &str,
    exit: &str,
    size: &str,
    command: &str,
) -> String {
    format!(
        "{:<14} {:<8} {:<8} {:<10} {:>7} {:>7} {:>9} {}",
        task_id,
        kind,
        truncate(session_id, 8),
        status,
        pid,
        exit,
        size,
        command,
    )
}

#[derive(Debug, Deserialize)]
struct AgentRecordFile {
    child_id: String,
    session_id: String,
    name: String,
    agent: String,
    model: Option<String>,
    status: String,
}

fn agent_status_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

/// Read `<home>/sessions/*/agents/*.json` written by the extension (§4.3).
fn load_agent_records(
    home: &Path,
    session_filter: Option<&str>,
    connected: &HashSet<String>,
) -> Vec<AgentRecordFile> {
    let sessions = home.join("sessions");
    let Ok(entries) = std::fs::read_dir(&sessions) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let sid = entry.file_name();
        let sid = sid.to_string_lossy();
        if let Some(want) = session_filter {
            if sid.as_ref() != want {
                continue;
            }
        }
        let agents_dir = entry.path().join("agents");
        let Ok(files) = std::fs::read_dir(agents_dir) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(file.path()) else {
                continue;
            };
            let Ok(mut rec) = serde_json::from_slice::<AgentRecordFile>(&bytes) else {
                continue;
            };
            // A session that is not connected cannot have a live child.
            if !connected.contains(&rec.session_id) && !agent_status_terminal(&rec.status) {
                rec.status = "interrupted".into();
            }
            out.push(rec);
        }
    }
    out.sort_by(|a, b| a.child_id.cmp(&b.child_id));
    out
}

pub async fn cmd_output(
    home: &Path,
    task_id: &str,
    follow: bool,
    max_bytes: u64,
) -> Result<(), String> {
    let task_id = resolve_cli_task_id(home, task_id).await?;
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let mut cursor = 0u64;
    let stdout = std::io::stdout();
    loop {
        let resp: OutputOk = conn
            .roundtrip(RequestKind::Output {
                task_id: task_id.to_string(),
                cursor,
                max_bytes,
            })
            .await?;
        {
            let mut out = stdout.lock();
            out.write_all(resp.chunk.as_bytes()).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
        cursor = resp.next_cursor;
        let caught_up = cursor >= resp.total_size;
        if resp.status.is_terminal() && caught_up {
            break;
        }
        if !follow && caught_up {
            break;
        }
        if resp.chunk.is_empty() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    Ok(())
}

pub async fn cmd_stop(home: &Path, task_id: &str) -> Result<(), String> {
    let task_id = resolve_cli_task_id(home, task_id).await?;
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let _: UnitOk = conn
        .roundtrip(RequestKind::Stop {
            task_id: task_id.to_string(),
            reason: Some("cli".into()),
        })
        .await?;
    println!("stopped {task_id}");
    Ok(())
}

/// kill-session is built from list + stop so the wire protocol stays exactly
/// as documented (§3.3 has no cross-session shutdown message).
pub async fn cmd_kill_session(home: &Path, session_id: &str) -> Result<(), String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let res: ListOk = conn
        .roundtrip(RequestKind::List {
            all: true,
            session_id: Some(session_id.to_string()),
        })
        .await?;
    let mut stopped = 0usize;
    for t in res.tasks {
        if t.status == TaskStatus::Running {
            let _: UnitOk = conn
                .roundtrip(RequestKind::Stop {
                    task_id: t.task_id.clone(),
                    reason: Some("cli".into()),
                })
                .await?;
            println!("stopped {}", t.task_id);
            stopped += 1;
        }
    }
    println!("session {session_id}: stopped {stopped} task(s)");
    Ok(())
}

pub async fn cmd_shutdown(home: &Path) -> Result<(), String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let _: UnitOk = conn.roundtrip(RequestKind::Shutdown).await?;
    println!("manager shutting down");
    Ok(())
}

/// Extra CLI convenience (not in §3.5): start a task. Needs a session to own
/// the task, so this hellos as an extension connection.
pub async fn cmd_start(
    home: &Path,
    session: &str,
    kind: &str,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    background: bool,
    command: &str,
) -> Result<(), String> {
    let kind = match kind {
        "shell" => TaskKind::Shell,
        "monitor" => TaskKind::Monitor,
        other => return Err(format!("unknown kind {other:?} (expected shell|monitor)")),
    };
    let cwd = match cwd {
        Some(c) => Some(c),
        None => Some(
            std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())?,
        ),
    };
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let mut conn = connect(
        home,
        &HelloMode::Extension {
            session_id: session.to_string(),
        },
    )
    .await?;
    let res: StartOk = conn
        .roundtrip(RequestKind::Start {
            kind,
            command: command.to_string(),
            cwd,
            env,
            run_in_background: background,
            timeout_ms,
            origin: None,
        })
        .await?;
    println!("task_id={} pid={}", res.task_id, res.pid);
    Ok(())
}

/// Extra CLI convenience (not in §3.5): budget-wait on a task.
pub async fn cmd_wait(home: &Path, task_id: &str, budget_ms: u64) -> Result<(), String> {
    let task_id = resolve_cli_task_id(home, task_id).await?;
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let res: WaitOk = conn
        .roundtrip(RequestKind::Wait {
            task_id: task_id.to_string(),
            budget_ms,
        })
        .await?;
    if res.done {
        match res.exit_code {
            Some(c) => println!("done exit_code={c}"),
            None => println!("done exit_code=null"),
        }
    } else {
        println!("not done (budget expired; task still running)");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Offline subcommands: doctor & log (no socket needed)
// ---------------------------------------------------------------------------

/// §3.5 doctor: socket/pid/lock consistency check; clean zombie files.
pub async fn cmd_doctor(home: &Path) -> i32 {
    println!("home:   {}", home.display());
    println!("socket: {}", lifecycle::socket_path(home).display());
    println!("pid:    {}", lifecycle::pid_path(home).display());
    println!("lock:   {}", lifecycle::lock_path(home).display());
    let mut problems = 0;
    match lifecycle::read_pid_file(home) {
        Some(pf) => println!(
            "pid file: pid={} version={} started_at={}",
            pf.pid, pf.version, pf.started_at
        ),
        None => println!("pid file: absent"),
    }
    // Liveness is the daemon's lifetime lock on manager.lock, not the pid
    // (the pid may have been reused by an unrelated process).
    match lifecycle::clean_if_no_daemon(home) {
        Ok(None) => {
            println!("daemon: running (holds {})", lifecycle::daemon_lock_path(home).display());
            match try_connect_and_hello(home, &HelloMode::Cli).await {
                Ok(_) => println!("socket: hello ok"),
                Err(e) => {
                    println!("socket: NOT responding ({e}) — daemon holds the lock, not cleaning");
                    problems += 1;
                }
            }
        }
        Ok(Some(removed)) if removed.is_empty() => {
            println!("daemon: not running; no stale files");
        }
        Ok(Some(removed)) => {
            for p in &removed {
                println!("daemon: not running; removed stale {}", p.display());
            }
            problems += 1;
        }
        Err(e) => {
            println!("daemon lock check failed: {e}");
            problems += 1;
        }
    }
    if problems == 0 {
        println!("ok");
    } else {
        println!("{problems} problem(s) found");
    }
    0
}

/// §3.5 log: tail manager.log; -f follows by polling the file size.
pub async fn cmd_log(
    home: &Path,
    follow: bool,
    lines: usize,
    task_id: Option<&str>,
    stderr: bool,
) -> Result<(), String> {
    match task_id {
        None => {
            if stderr {
                return Err("--stderr requires a TASK_ID (manager.log has no stderr stream)".into());
            }
            cmd_log_manager(home, follow, lines).await
        }
        Some(id) => cmd_log_task(home, id, follow, lines, stderr).await,
    }
}

async fn cmd_log_manager(home: &Path, follow: bool, lines: usize) -> Result<(), String> {
    let path = lifecycle::log_path(home);
    tail_file(&path, follow, lines).await
}

async fn cmd_log_task(
    home: &Path,
    task_id: &str,
    follow: bool,
    lines: usize,
    stderr: bool,
) -> Result<(), String> {
    // Resolve the on-disk path via list (works for any session the CLI can see).
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let res: ListOk = conn
        .roundtrip(RequestKind::List {
            all: true,
            session_id: None,
        })
        .await?;
    let known: Vec<String> = res.tasks.iter().map(|t| t.task_id.clone()).collect();
    let task_id = resolve_task_id(task_id, &known)?;
    let task = res
        .tasks
        .into_iter()
        .find(|t| t.task_id == task_id)
        .ok_or_else(|| format!("unknown task_id {task_id}"))?;
    let path = if stderr {
        task::stderr_path_for(Path::new(&task.output_path))
    } else {
        PathBuf::from(&task.output_path)
    };
    if !path.exists() {
        if stderr {
            return Err(format!(
                "no stderr file for {task_id} yet (path {}); task may have written nothing to stderr, or it was started before stderr capture was added — restart the task",
                path.display()
            ));
        }
        return Err(format!("no output file at {}", path.display()));
    }
    // Drop the short-lived list connection before a long follow so we don't
    // keep an idle hello slot open for the whole -f session.
    drop(conn);
    tail_file(&path, follow, lines).await
}

/// Fuzzy-resolve a task id the same way `log`/`tail` do (note on stderr).
async fn resolve_cli_task_id(home: &Path, typed: &str) -> Result<String, String> {
    let mut conn = connect(home, &HelloMode::Cli).await?;
    let res: ListOk = conn
        .roundtrip(RequestKind::List {
            all: true,
            session_id: None,
        })
        .await?;
    let known: Vec<String> = res.tasks.iter().map(|t| t.task_id.clone()).collect();
    resolve_task_id(typed, &known)
}

/// Resolve a user-typed task id against the known set.
/// Accepts exact match, unique suffix/prefix/substring, and unique near-miss
/// (Levenshtein ≤ 2) so typos like `cmon_…` for `mon_…` still work.
fn resolve_task_id(typed: &str, known: &[String]) -> Result<String, String> {
    if known.iter().any(|k| k == typed) {
        return Ok(typed.to_string());
    }
    let hits: Vec<&String> = known
        .iter()
        .filter(|k| {
            k.ends_with(typed)
                || typed.ends_with(k.as_str())
                || k.contains(typed)
                || typed.contains(k.as_str())
        })
        .collect();
    if hits.len() == 1 {
        eprintln!("note: resolved '{typed}' → '{}'", hits[0]);
        return Ok(hits[0].clone());
    }
    if hits.len() > 1 {
        return Err(format!(
            "ambiguous task_id '{typed}' (matches: {}); pick one",
            hits.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    // Near-miss suggestion.
    let mut best: Option<(&String, usize)> = None;
    for k in known {
        let d = edit_distance(typed, k);
        if d <= 2 && best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((k, d));
        }
    }
    let known_list = if known.is_empty() {
        "none".into()
    } else {
        known.join(", ")
    };
    Err(match best {
        Some((k, _)) => format!("unknown task_id '{typed}' (did you mean '{k}'?). known: {known_list}"),
        None => format!("unknown task_id '{typed}'. known: {known_list}"),
    })
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > 2 {
        return 3; // early out: already worse than our suggestion threshold
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0; m + 1];
    for i in 1..=n {
        cur[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m]
}

async fn tail_file(path: &Path, follow: bool, lines: usize) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&data);
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    for line in &all[start..] {
        println!("{line}");
    }
    if !follow {
        return Ok(());
    }
    let mut offset = data.len() as u64;
    let stdout = std::io::stdout();
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let size = match std::fs::metadata(path) {
            Ok(m) => m.len(),
            Err(_) => continue,
        };
        if size < offset {
            offset = 0; // truncated/rotated
        }
        if size > offset {
            let (bytes, next) = task::read_file_range(path, offset, (size - offset) as usize)
                .map_err(|e| e.to_string())?;
            let mut out = stdout.lock();
            out.write_all(&bytes).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            offset = next;
        }
    }
}

/// COMMAND column: first line only, then char-cap (heredocs / multiline stay readable).
fn truncate_command(s: &str, max: usize) -> String {
    let first = s.lines().next().unwrap_or("");
    truncate(first, max)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::{format_ls_row, ls_header, resolve_task_id};

    #[test]
    fn exact_and_typo_prefix() {
        let known = vec!["mon_e1351cb1".into(), "sh_071f52c1".into()];
        assert_eq!(resolve_task_id("mon_e1351cb1", &known).unwrap(), "mon_e1351cb1");
        assert_eq!(resolve_task_id("cmon_e1351cb1", &known).unwrap(), "mon_e1351cb1");
        assert_eq!(resolve_task_id("e1351cb1", &known).unwrap(), "mon_e1351cb1");
    }

    #[test]
    fn unknown_suggests() {
        let known = vec!["mon_e1351cb1".into()];
        let err = resolve_task_id("mon_e1351cb2", &known).unwrap_err();
        assert!(err.contains("did you mean"), "{err}");
        assert!(err.contains("mon_e1351cb1"), "{err}");
    }

    #[test]
    fn ls_table_has_kind_column() {
        let header = ls_header();
        assert!(header.contains("KIND"), "{header}");
        let mon = format_ls_row("mon_7f409501", "monitor", "repro", "running", "1", "-", "5", "while true");
        assert!(mon.contains("monitor"), "{mon}");
        assert!(mon.contains("mon_7f409501"), "{mon}");
        let agent = format_ls_row("ch_deadbeef", "agent", "sess", "running", "-", "-", "-", "agent:a (worker)");
        assert!(agent.contains("agent"), "{agent}");
        let shell = format_ls_row("sh_071f52c1", "shell", "sess", "running", "2", "-", "0", "echo hi");
        assert!(shell.contains("shell"), "{shell}");
        // EXIT shows signal names (§3.3); they must not shift COMMAND.
        let killed = format_ls_row("sh_071f52c1", "shell", "sess", "killed", "2", "SIGTERM", "0", "echo hi");
        assert_eq!(killed.find("echo hi"), header.find("COMMAND"), "{header}\n{killed}");
        assert_eq!(shell.find("echo hi"), header.find("COMMAND"));
    }
}
