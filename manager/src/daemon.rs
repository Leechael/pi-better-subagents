//! Daemon core (design doc §3.1–§3.4): unix socket listener, accept loop,
//! hello handshake + connection registry, request dispatch, event fanout, and
//! the anti-zombie lifecycle — zero active connections for 5s -> graceful
//! shutdown (SIGTERM all task groups -> 2s -> SIGKILL -> clean socket/pid).

use crate::lifecycle::{self, Claim};
use crate::proto::*;
use crate::registry::{self, Access, Registry, TaskEntry};
use crate::task::{self, SpawnedTask};
use interprocess::local_socket::tokio::prelude::*; // traits for accept()/connect()
use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};
use serde::Serialize;
use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

/// §3.2: zero active connections for this long -> graceful shutdown.
const IDLE_SHUTDOWN: Duration = Duration::from_secs(5);
/// §3.2/§3.3: SIGTERM grace before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Hygiene: a connection must complete hello within this window (it does not
/// count as an active connection until then).
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Server-side cap for one output read (keeps frames well under the 4 MiB
/// frame limit even after UTF-8-lossy expansion).
const MAX_OUTPUT_READ: u64 = 1024 * 1024;
/// §3.4: re-adopted tasks are polled with kill(pid, 0) every second.
const ADOPT_POLL: Duration = Duration::from_secs(1);

type OutTx = mpsc::Sender<Arc<Vec<u8>>>;
pub type Shared = Arc<Mutex<DaemonState>>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct ConnHandle {
    pub kind: ClientKind,
    pub session_id: Option<String>,
    pub tx: OutTx,
    /// Fired to make the connection's read loop exit (session rebind).
    pub die: Arc<Notify>,
}

pub struct SessionEntry {
    pub pi_pid: u32,
    pub conn_id: Option<u64>,
    pub cwd: Option<String>,
}

pub struct DaemonState {
    pub home: PathBuf,
    pub started: Instant,
    pub started_at_ms: u64,
    pub registry: Registry,
    /// Active (hello-completed) connections; the §3.2 idle rule counts these.
    pub conns: HashMap<u64, ConnHandle>,
    pub sessions: HashMap<String, SessionEntry>,
    pub next_conn_id: u64,
    pub idle_timer: Option<tokio::task::JoinHandle<()>>,
    pub shutdown: bool,
    pub shutdown_notify: Arc<Notify>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(home: PathBuf, foreground: bool) -> i32 {
    if let Err(e) = std::fs::create_dir_all(&home) {
        eprintln!("pbs-manager: cannot create {}: {e}", home.display());
        return 1;
    }
    // §3.1: refuse to start over a live manager; take over from a dead one.
    match lifecycle::claim_pid(&home) {
        Ok(Claim::Acquired) => {}
        Ok(Claim::AlreadyRunning { pid }) => {
            println!("pbs-manager already running (pid {pid})");
            return 0;
        }
        Err(e) => {
            eprintln!("pbs-manager: pid claim failed: {e}");
            return 1;
        }
    }

    let mut registry = Registry::new(home.clone());
    let scan = lifecycle::scan_tasks(&home, &mut registry);
    let state: Shared = Arc::new(Mutex::new(DaemonState {
        home: home.clone(),
        started: Instant::now(),
        started_at_ms: now_ms(),
        registry,
        conns: HashMap::new(),
        sessions: HashMap::new(),
        next_conn_id: 1,
        idle_timer: None,
        shutdown: false,
        shutdown_notify: Arc::new(Notify::new()),
    }));

    // Bind the well-known socket (§3.1).
    let sock = lifecycle::socket_path(&home);
    let name = match sock.as_os_str().to_fs_name::<GenericFilePath>() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("pbs-manager: bad socket path {}: {e}", sock.display());
            return 1;
        }
    };
    let listener = match ListenerOptions::new().name(name).create_tokio() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("pbs-manager: cannot listen on {}: {e}", sock.display());
            return 1;
        }
    };
    if let Err(e) = lifecycle::write_pid_file(&home, std::process::id()) {
        eprintln!("pbs-manager: cannot write pid file: {e}");
        return 1;
    }
    lifecycle::log_line(
        &home,
        &format!(
            "daemon started pid={} version={} readopted={} orphaned={} loaded={}",
            std::process::id(),
            env!("CARGO_PKG_VERSION"),
            scan.readopted.len(),
            scan.orphaned,
            scan.loaded
        ),
    );
    if foreground {
        eprintln!(
            "pbs-manager {} listening on {} (pid {})",
            env!("CARGO_PKG_VERSION"),
            sock.display(),
            std::process::id()
        );
    }

    // §3.4: re-adopted tasks get a kill(pid,0) poller + output tailer.
    for (task_id, pid) in scan.readopted {
        spawn_adopted_poller(&state, &task_id, pid);
    }

    // §3.2: the idle rule applies from boot (clients connect within 2s of
    // spawn per §3.1, so this never fires for a healthy startup).
    maybe_arm_idle_timer(&state);

    let shutdown_notify = state.lock().unwrap().shutdown_notify.clone();
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).ok();

    loop {
        tokio::select! {
            res = listener.accept() => match res {
                Ok(stream) => {
                    let s = state.clone();
                    tokio::spawn(async move { handle_conn(s, stream).await });
                }
                Err(e) => {
                    lifecycle::log_line(&home, &format!("accept error: {e}"));
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown_notify.notified() => break,
            _ = async {
                match sigterm.as_mut() {
                    Some(s) => { s.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {
                lifecycle::log_line(&home, "received SIGTERM");
                break;
            }
            _ = async {
                match sigint.as_mut() {
                    Some(s) => { s.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {
                lifecycle::log_line(&home, "received SIGINT");
                break;
            }
        }
    }

    graceful_shutdown(&state).await;
    0
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

fn valid_session_id(s: &str) -> bool {
    // Session ids become directory names; keep them path-safe.
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn parse_request(bytes: &[u8]) -> Result<Request, (String, String)> {
    let v: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| (String::new(), format!("invalid JSON: {e}")))?;
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    serde_json::from_value::<Request>(v).map_err(|e| (id, format!("bad request: {e}")))
}

async fn writer_task<W: tokio::io::AsyncWrite + Unpin>(
    mut w: W,
    mut rx: mpsc::Receiver<Arc<Vec<u8>>>,
) {
    while let Some(payload) = rx.recv().await {
        if write_frame(&mut w, &payload).await.is_err() {
            break;
        }
    }
}

async fn handle_conn(state: Shared, stream: Stream) {
    let (mut rd, wr) = tokio::io::split(stream);
    let (tx, rx) = mpsc::channel::<Arc<Vec<u8>>>(1024);
    let die = Arc::new(Notify::new());
    tokio::spawn(writer_task(wr, rx));

    // ---- hello: must be the first message on the connection (§3.3) ----
    let first = match tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut rd)).await {
        Ok(Ok(Some(bytes))) => bytes,
        _ => return, // timeout / EOF / io error before hello: never registered
    };
    let hello = match parse_request(&first) {
        Ok(r) => r,
        Err((id, msg)) => {
            let _ = tx.send(encode_error(&id, E_BAD_REQUEST, &msg)).await;
            return;
        }
    };
    if matches!(hello.v, Some(v) if v != PROTO_VERSION) {
        let _ = tx
            .send(encode_error(&hello.id, E_VERSION, "unsupported protocol version"))
            .await;
        return;
    }
    let (client_kind, session_id, pi_pid, cwd) = match hello.kind {
        RequestKind::Hello {
            client_kind,
            session_id,
            pi_pid,
            cwd,
        } => (client_kind, session_id, pi_pid, cwd),
        _ => {
            let _ = tx
                .send(encode_error(&hello.id, E_BAD_REQUEST, "first message must be hello"))
                .await;
            return;
        }
    };
    if client_kind == ClientKind::Extension {
        let ok = matches!(&session_id, Some(s) if valid_session_id(s)) && pi_pid.is_some();
        if !ok {
            let _ = tx
                .send(encode_error(
                    &hello.id,
                    E_BAD_REQUEST,
                    "extension hello requires session_id and pi_pid",
                ))
                .await;
            return;
        }
    }

    let conn_id = match register_conn(&state, &tx, &die, client_kind, session_id, pi_pid, cwd) {
        Ok(id) => id,
        Err(e) => {
            let _ = tx.send(encode_error(&hello.id, &e.code, &e.message)).await;
            return;
        }
    };
    let started_at = state.lock().unwrap().started_at_ms;
    let _ = tx
        .send(encode_ok(
            &hello.id,
            &HelloOk {
                version: env!("CARGO_PKG_VERSION").to_string(),
                pid: std::process::id(),
                started_at,
            },
        ))
        .await;

    // ---- request loop (requests may be pipelined; each runs in its own task) ----
    loop {
        let frame = tokio::select! {
            f = read_frame(&mut rd) => match f {
                Ok(Some(b)) => b,
                _ => break, // EOF / io error / oversized frame
            },
            _ = die.notified() => break, // rebound by a newer connection
        };
        let req = match parse_request(&frame) {
            Ok(r) => r,
            Err((id, msg)) => {
                let _ = tx.send(encode_error(&id, E_BAD_REQUEST, &msg)).await;
                continue;
            }
        };
        if matches!(req.v, Some(v) if v != PROTO_VERSION) {
            let _ = tx
                .send(encode_error(&req.id, E_VERSION, "unsupported protocol version"))
                .await;
            continue;
        }
        let s2 = state.clone();
        let tx2 = tx.clone();
        tokio::spawn(async move { dispatch(s2, conn_id, req, tx2).await });
    }

    // ---- disconnect (§3.2: socket close marks the session disconnected) ----
    {
        let mut st = state.lock().unwrap();
        remove_conn(&mut st, conn_id);
    }
    maybe_arm_idle_timer(&state);
}

/// Register a hello'd connection. Same-session rebind: the new connection
/// wins; the old one gets `session_rebound` and is closed (§3.3).
fn register_conn(
    state: &Shared,
    tx: &OutTx,
    die: &Arc<Notify>,
    kind: ClientKind,
    session_id: Option<String>,
    pi_pid: Option<u32>,
    cwd: Option<String>,
) -> Result<u64, ProtoError> {
    let mut st = state.lock().unwrap();
    if st.shutdown {
        return Err(ProtoError::new(E_INTERNAL, "manager is shutting down"));
    }
    // A fresh active connection cancels any pending idle shutdown (§3.2).
    if let Some(t) = st.idle_timer.take() {
        t.abort();
    }
    let conn_id = st.next_conn_id;
    st.next_conn_id += 1;
    if kind == ClientKind::Extension {
        let sid = session_id.clone().unwrap_or_default();
        let old = st.sessions.get(&sid).and_then(|s| s.conn_id);
        if let Some(old_id) = old {
            if let Some(old_h) = st.conns.get(&old_id) {
                let _ = old_h.tx.try_send(encode_event(&EventKind::SessionRebound {}));
                old_h.die.notify_one();
            }
            remove_conn(&mut st, old_id);
        }
        st.sessions.insert(
            sid,
            SessionEntry {
                pi_pid: pi_pid.unwrap_or(0),
                conn_id: Some(conn_id),
                cwd,
            },
        );
    }
    st.conns.insert(
        conn_id,
        ConnHandle {
            kind,
            session_id,
            tx: tx.clone(),
            die: die.clone(),
        },
    );
    Ok(conn_id)
}

fn remove_conn(st: &mut DaemonState, conn_id: u64) {
    if let Some(h) = st.conns.remove(&conn_id) {
        if let Some(sid) = &h.session_id {
            if let Some(s) = st.sessions.get_mut(sid) {
                if s.conn_id == Some(conn_id) {
                    s.conn_id = None; // session now disconnected (§3.2)
                }
            }
        }
        for t in st.registry.tasks.values_mut() {
            t.watchers.remove(&conn_id);
        }
    }
}

/// §3.2: arm the 5s idle timer when the last active connection went away.
fn maybe_arm_idle_timer(state: &Shared) {
    let mut st = state.lock().unwrap();
    if st.shutdown || !st.conns.is_empty() || st.idle_timer.is_some() {
        return;
    }
    let state2 = state.clone();
    st.idle_timer = Some(tokio::spawn(async move {
        tokio::time::sleep(IDLE_SHUTDOWN).await;
        let fired = {
            let mut st = state2.lock().unwrap();
            if st.conns.is_empty() && !st.shutdown {
                st.shutdown = true;
                Some((st.home.clone(), st.shutdown_notify.clone()))
            } else {
                None
            }
        };
        if let Some((home, notify)) = fired {
            lifecycle::log_line(&home, "no active connections for 5s; graceful shutdown");
            notify.notify_one();
        }
    }));
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async fn dispatch(state: Shared, conn_id: u64, req: Request, tx: OutTx) {
    let id = req.id;
    match req.kind {
        RequestKind::Hello { .. } => {
            let _ = tx
                .send(encode_error(&id, E_BAD_REQUEST, "connection already said hello"))
                .await;
        }
        RequestKind::Start {
            kind,
            command,
            cwd,
            env,
            timeout_ms,
            ..
        } => respond(&tx, &id, handle_start(&state, conn_id, kind, command, cwd, env, timeout_ms)).await,
        RequestKind::Wait { task_id, budget_ms } => {
            respond(&tx, &id, handle_wait(&state, conn_id, &task_id, budget_ms).await).await
        }
        RequestKind::Output {
            task_id,
            cursor,
            max_bytes,
        } => respond(&tx, &id, handle_output(&state, conn_id, &task_id, cursor, max_bytes)).await,
        RequestKind::Stop { task_id } => {
            respond(&tx, &id, handle_stop(&state, conn_id, &task_id)).await
        }
        RequestKind::List { all, session_id } => {
            respond(&tx, &id, handle_list(&state, conn_id, all, session_id)).await
        }
        RequestKind::Watch { task_id } => {
            respond(&tx, &id, handle_watch(&state, conn_id, &task_id, true)).await
        }
        RequestKind::Unwatch { task_id } => {
            respond(&tx, &id, handle_watch(&state, conn_id, &task_id, false)).await
        }
        RequestKind::ShutdownSession => {
            respond(&tx, &id, handle_shutdown_session(&state, conn_id)).await
        }
        RequestKind::Status => respond(&tx, &id, handle_status(&state, conn_id)).await,
        RequestKind::Shutdown => respond(&tx, &id, handle_shutdown(&state, conn_id)).await,
    }
}

async fn respond<T: Serialize>(tx: &OutTx, id: &str, result: Result<T, ProtoError>) {
    let frame = match result {
        Ok(body) => encode_ok(id, &body),
        Err(e) => encode_error(id, &e.code, &e.message),
    };
    let _ = tx.send(frame).await;
}

fn encode_ok<T: Serialize>(id: &str, body: &T) -> Arc<Vec<u8>> {
    Arc::new(encode(&Response {
        v: PROTO_VERSION,
        id: id.to_string(),
        ok: true,
        body,
    }))
}

fn encode_error(id: &str, code: &str, message: &str) -> Arc<Vec<u8>> {
    Arc::new(encode(&Response {
        v: PROTO_VERSION,
        id: id.to_string(),
        ok: false,
        body: ErrorBody {
            error: ProtoError::new(code, message),
        },
    }))
}

fn encode_event(kind: &EventKind) -> Arc<Vec<u8>> {
    Arc::new(encode(&Event::new(kind.clone())))
}

fn access_for(st: &DaemonState, conn_id: u64) -> Access {
    match st.conns.get(&conn_id) {
        Some(h) if h.kind == ClientKind::Extension => match &h.session_id {
            Some(sid) => Access::Extension(sid.clone()),
            None => Access::Cli,
        },
        _ => Access::Cli,
    }
}

fn send_event_to_session(state: &Shared, session_id: &str, kind: EventKind) {
    let tx = {
        let st = state.lock().unwrap();
        st.sessions
            .get(session_id)
            .and_then(|s| s.conn_id)
            .and_then(|cid| st.conns.get(&cid))
            .map(|h| h.tx.clone())
    };
    if let Some(tx) = tx {
        let _ = tx.try_send(encode_event(&kind));
    }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

fn handle_start(
    state: &Shared,
    conn_id: u64,
    kind: TaskKind,
    command: String,
    cwd: Option<String>,
    env: HashMap<String, String>,
    timeout_ms: Option<u64>,
) -> Result<StartOk, ProtoError> {
    let (session_id, home) = {
        let st = state.lock().unwrap();
        if st.shutdown {
            return Err(ProtoError::new(E_INTERNAL, "manager is shutting down"));
        }
        let h = st
            .conns
            .get(&conn_id)
            .ok_or_else(|| ProtoError::new(E_INTERNAL, "connection gone"))?;
        // §3.3: session_id comes from the connection binding.
        let sid = match &h.session_id {
            Some(s) => s.clone(),
            None => {
                return Err(ProtoError::new(
                    E_SESSION_REQUIRED,
                    "start requires an extension session",
                ))
            }
        };
        (sid, st.home.clone())
    };
    if command.trim().is_empty() {
        return Err(ProtoError::new(E_BAD_REQUEST, "empty command"));
    }
    let cwd = cwd.unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into())
    });

    let (task_id, out_path) = {
        let st = state.lock().unwrap();
        let id = st.registry.generate_task_id(kind);
        let path = registry::task_output_path(&home, &session_id, &id);
        (id, path)
    };
    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let spawned = task::spawn(&command, &cwd, &env, &out_path)
        .map_err(|e| ProtoError::new(E_INTERNAL, format!("spawn failed: {e}")))?;
    let SpawnedTask {
        child,
        pid,
        output,
        chunks,
        tee_remaining: _,
    } = spawned;

    let now = now_ms();
    let record = TaskRecord {
        task_id: task_id.clone(),
        session_id: session_id.clone(),
        kind,
        command: command.clone(),
        cwd,
        pid,
        status: TaskStatus::Running,
        exit_code: None,
        signal: None,
        started_at: now,
        ended_at: None,
        output_path: out_path.to_string_lossy().into_owned(),
        output_size: 0,
    };
    if let Err(e) = registry::persist_record(&home, &record) {
        let _ = task::signal_group(pid, task::SIGKILL); // don't leak the child
        return Err(ProtoError::new(E_INTERNAL, format!("persist failed: {e}")));
    }

    {
        let mut st = state.lock().unwrap();
        st.registry.tasks.insert(
            task_id.clone(),
            TaskEntry::new_running(record, child, output, chunks, timeout_ms),
        );
    }
    spawn_output_fanout(state, &task_id);
    spawn_exit_watch(state, &task_id, pid);
    // §3.3: task_started is always pushed to the owning session.
    send_event_to_session(
        state,
        &session_id,
        EventKind::TaskStarted {
            task_id: task_id.clone(),
            kind,
            command,
            pid,
            ts: now,
        },
    );
    Ok(StartOk { task_id, pid })
}

async fn handle_wait(
    state: &Shared,
    conn_id: u64,
    task_id: &str,
    budget_ms: u64,
) -> Result<WaitOk, ProtoError> {
    let mut rx = {
        let st = state.lock().unwrap();
        let acc = access_for(&st, conn_id);
        let e = st.registry.visible(task_id, &acc)?;
        if e.record.status.is_terminal() {
            return Ok(WaitOk {
                done: true,
                exit_code: e.record.exit_code,
            });
        }
        e.status_tx.subscribe()
    };
    // Re-check after subscribing (finalize may have raced the subscribe).
    if rx.borrow().is_terminal() {
        let ec = state
            .lock()
            .unwrap()
            .registry
            .tasks
            .get(task_id)
            .and_then(|e| e.record.exit_code);
        return Ok(WaitOk {
            done: true,
            exit_code: ec,
        });
    }
    // §3.3: wait is a *budget* wait — on expiry the task keeps running.
    let deadline = tokio::time::sleep(Duration::from_millis(budget_ms));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() || rx.borrow().is_terminal() {
                    let ec = state
                        .lock()
                        .unwrap()
                        .registry
                        .tasks
                        .get(task_id)
                        .and_then(|e| e.record.exit_code);
                    return Ok(WaitOk { done: true, exit_code: ec });
                }
            }
            _ = &mut deadline => return Ok(WaitOk { done: false, exit_code: None }),
        }
    }
}

fn handle_output(
    state: &Shared,
    conn_id: u64,
    task_id: &str,
    cursor: u64,
    max_bytes: u64,
) -> Result<OutputOk, ProtoError> {
    let cap = max_bytes.min(MAX_OUTPUT_READ) as usize;
    enum Src {
        Ring(Vec<u8>),
        Disk(String),
    }
    let (src, status, exit_code, total_size) = {
        let st = state.lock().unwrap();
        let acc = access_for(&st, conn_id);
        let e = st.registry.visible(task_id, &acc)?;
        let out = e.output.lock().unwrap();
        let total = out.total_size;
        // Serve from the 64KB ring when the range is fully retained (§3.4);
        // otherwise fall back to the full on-disk stream.
        let ring_start = total.saturating_sub(out.ring.len() as u64);
        let src = if cursor >= ring_start && cursor < total {
            let skip = (cursor - ring_start) as usize;
            let avail = out.ring.len() - skip;
            Src::Ring(out.ring.slice(skip, avail.min(cap)))
        } else {
            Src::Disk(e.record.output_path.clone())
        };
        (src, e.record.status, e.record.exit_code, total)
    };
    let bytes = match src {
        Src::Ring(b) => b,
        Src::Disk(path) => {
            task::read_file_range(std::path::Path::new(&path), cursor, cap)
                .map_err(|e| ProtoError::new(E_INTERNAL, format!("read output: {e}")))?
                .0
        }
    };
    let next_cursor = cursor + bytes.len() as u64;
    Ok(OutputOk {
        chunk: String::from_utf8_lossy(&bytes).into_owned(), // §3.3: UTF-8 lossy
        next_cursor,
        status,
        exit_code,
        total_size,
    })
}

fn handle_stop(state: &Shared, conn_id: u64, task_id: &str) -> Result<UnitOk, ProtoError> {
    let pid = {
        let mut st = state.lock().unwrap();
        let acc = access_for(&st, conn_id);
        let e = st.registry.visible_mut(task_id, &acc)?;
        if e.record.status.is_terminal() {
            return Ok(UnitOk {}); // idempotent
        }
        e.kill_requested = true; // exit path maps this to `killed` (§3.4)
        e.record.pid
    };
    // §3.3 stop: SIGTERM the process group, 2s grace, then SIGKILL.
    let _ = task::signal_group(pid, task::SIGTERM);
    spawn_kill_reaper(state, task_id, pid);
    Ok(UnitOk {})
}

fn spawn_kill_reaper(state: &Shared, task_id: &str, pid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(KILL_GRACE).await;
        let still_running = {
            state2
                .lock()
                .unwrap()
                .registry
                .tasks
                .get(&tid)
                .map(|e| e.record.status == TaskStatus::Running)
                .unwrap_or(false)
        };
        if still_running {
            let _ = task::signal_group(pid, task::SIGKILL);
        }
    });
}

fn handle_list(
    state: &Shared,
    conn_id: u64,
    _all: bool,
    session_id: Option<String>,
) -> Result<ListOk, ProtoError> {
    let st = state.lock().unwrap();
    let acc = access_for(&st, conn_id);
    let mut tasks: Vec<TaskRecord> = st
        .registry
        .tasks
        .values()
        .filter(|e| match &acc {
            // §3.3: extension connections only ever see their own session.
            Access::Extension(sid) => e.record.session_id == *sid,
            // cli is admin: explicit session filter, otherwise everything.
            Access::Cli => match &session_id {
                Some(s) => e.record.session_id == *s,
                None => true,
            },
        })
        .map(|e| e.record.clone())
        .collect();
    tasks.sort_by_key(|r| r.started_at);
    Ok(ListOk { tasks })
}

fn handle_watch(
    state: &Shared,
    conn_id: u64,
    task_id: &str,
    on: bool,
) -> Result<UnitOk, ProtoError> {
    let mut st = state.lock().unwrap();
    let acc = access_for(&st, conn_id);
    let e = st.registry.visible_mut(task_id, &acc)?;
    if on {
        e.watchers.insert(conn_id);
    } else {
        e.watchers.remove(&conn_id);
    }
    Ok(UnitOk {})
}

fn handle_shutdown_session(state: &Shared, conn_id: u64) -> Result<ShutdownSessionOk, ProtoError> {
    let victims = {
        let mut st = state.lock().unwrap();
        let h = st
            .conns
            .get(&conn_id)
            .ok_or_else(|| ProtoError::new(E_INTERNAL, "connection gone"))?;
        let sid = match &h.session_id {
            Some(s) => s.clone(),
            None => {
                return Err(ProtoError::new(
                    E_SESSION_REQUIRED,
                    "shutdown_session requires an extension session",
                ))
            }
        };
        let mut v = Vec::new();
        for e in st.registry.tasks.values_mut() {
            if e.record.session_id == sid && e.record.status == TaskStatus::Running {
                e.kill_requested = true;
                v.push((e.record.task_id.clone(), e.record.pid));
            }
        }
        v
    };
    for (tid, pid) in &victims {
        let _ = task::signal_group(*pid, task::SIGTERM);
        spawn_kill_reaper(state, tid, *pid);
    }
    Ok(ShutdownSessionOk {
        stopped: victims.into_iter().map(|(t, _)| t).collect(),
    })
}

fn handle_status(state: &Shared, _conn_id: u64) -> Result<StatusOk, ProtoError> {
    let st = state.lock().unwrap();
    // Status is read-only. Extensions need it so task_list can drop ghost
    // agents whose session is no longer connected. Shutdown stays cli-only.
    let sessions = st
        .sessions
        .iter()
        .map(|(sid, s)| SessionInfo {
            session_id: sid.clone(),
            pi_pid: s.pi_pid,
            connected: s.conn_id.is_some(),
            cwd: s.cwd.clone(),
        })
        .collect();
    let running = st
        .registry
        .tasks
        .values()
        .filter(|e| e.record.status == TaskStatus::Running)
        .count();
    let terminal = st.registry.tasks.len() - running;
    Ok(StatusOk {
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        uptime_ms: st.started.elapsed().as_millis() as u64,
        sessions,
        task_counts: TaskCounts { running, terminal },
    })
}

fn handle_shutdown(state: &Shared, conn_id: u64) -> Result<UnitOk, ProtoError> {
    let mut st = state.lock().unwrap();
    // §3.3 marks shutdown as a cli message.
    if let Some(h) = st.conns.get(&conn_id) {
        if h.kind != ClientKind::Cli {
            return Err(ProtoError::new(E_FORBIDDEN, "shutdown is a cli-only operation"));
        }
    }
    // §3.3: same graceful shutdown as the zero-connection path (§3.2).
    st.shutdown = true;
    st.shutdown_notify.notify_one();
    Ok(UnitOk {})
}

// ---------------------------------------------------------------------------
// Background tasks: output fanout, exit watch, re-adopt poller
// ---------------------------------------------------------------------------

/// Forward tee'd output chunks to watching connections as `output` events
/// (§3.3: output events only after watch).
fn spawn_output_fanout(state: &Shared, task_id: &str) {
    let mut rx = {
        let mut st = state.lock().unwrap();
        match st
            .registry
            .tasks
            .get_mut(task_id)
            .and_then(|e| e.chunks_rx.take())
        {
            Some(rx) => rx,
            None => return,
        }
    };
    let state2 = state.clone();
    let tid = task_id.to_string();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let targets: Vec<OutTx> = {
                let mut st = state2.lock().unwrap();
                let watcher_ids: Vec<u64> = match st.registry.tasks.get_mut(&tid) {
                    Some(e) => {
                        e.record.output_size = chunk.next_cursor; // monotonic (§3.4)
                        e.watchers.iter().copied().collect()
                    }
                    None => break,
                };
                watcher_ids
                    .iter()
                    .filter_map(|cid| st.conns.get(cid).map(|h| h.tx.clone()))
                    .collect()
            };
            if !targets.is_empty() {
                let ev = encode_event(&EventKind::Output {
                    task_id: tid.clone(),
                    chunk: String::from_utf8_lossy(&chunk.bytes).into_owned(),
                    next_cursor: chunk.next_cursor,
                });
                for tx in targets {
                    let _ = tx.try_send(ev.clone());
                }
            }
        }
    });
}

/// Await child exit (or the hard timeout), then finalize the record.
fn spawn_exit_watch(state: &Shared, task_id: &str, pid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    tokio::spawn(async move {
        let (child, timeout_ms) = {
            let mut st = state2.lock().unwrap();
            match st.registry.tasks.get_mut(&tid) {
                Some(e) => (e.child.take(), e.timeout_ms),
                None => (None, None),
            }
        };
        let Some(mut child) = child else { return };
        let wait = child.wait();
        tokio::pin!(wait);
        let status = match timeout_ms {
            Some(ms) => {
                tokio::select! {
                    s = &mut wait => s.ok(),
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {
                        // §3.3: timeout_ms is a hard kill ceiling.
                        {
                            let mut st = state2.lock().unwrap();
                            if let Some(e) = st.registry.tasks.get_mut(&tid) {
                                if e.record.status == TaskStatus::Running {
                                    e.kill_requested = true;
                                }
                            }
                        }
                        let _ = task::signal_group(pid, task::SIGKILL);
                        wait.await.ok()
                    }
                }
            }
            None => wait.await.ok(),
        };
        finalize_exit(&state2, &tid, status);
    });
}

/// §3.4 re-adopt: poll kill(pid, 0) every second; keep tailing the output
/// file for late writes. Exit code is unobtainable -> completed/null.
fn spawn_adopted_poller(state: &Shared, task_id: &str, pid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(ADOPT_POLL);
        loop {
            tick.tick().await;
            let (path, known) = {
                let st = state2.lock().unwrap();
                match st.registry.tasks.get(&tid) {
                    Some(e) if e.record.status == TaskStatus::Running => {
                        let total = e.output.lock().unwrap().total_size;
                        (e.record.output_path.clone(), total)
                    }
                    _ => break, // finalized elsewhere (stop/shutdown)
                }
            };
            if let Ok((bytes, next)) =
                task::read_file_range(std::path::Path::new(&path), known, MAX_OUTPUT_READ as usize)
            {
                if !bytes.is_empty() {
                    let targets: Vec<OutTx> = {
                        let mut st = state2.lock().unwrap();
                        let watcher_ids: Vec<u64> = match st.registry.tasks.get_mut(&tid) {
                            Some(e) => {
                                e.output.lock().unwrap().append(&bytes);
                                e.record.output_size = next;
                                e.watchers.iter().copied().collect()
                            }
                            None => break,
                        };
                        watcher_ids
                            .iter()
                            .filter_map(|cid| st.conns.get(cid).map(|h| h.tx.clone()))
                            .collect()
                    };
                    if !targets.is_empty() {
                        let ev = encode_event(&EventKind::Output {
                            task_id: tid.clone(),
                            chunk: String::from_utf8_lossy(&bytes).into_owned(),
                            next_cursor: next,
                        });
                        for tx in targets {
                            let _ = tx.try_send(ev.clone());
                        }
                    }
                }
            }
            if !task::pid_alive(pid) {
                finalize_exit(&state2, &tid, None);
                break;
            }
        }
    });
}

/// Map an observed exit to a terminal status, persist the record, wake
/// `wait`ers, and push `task_exited` to the owning session (§3.3/§3.4).
fn finalize_exit(state: &Shared, task_id: &str, status: Option<std::process::ExitStatus>) {
    let (sid, event) = {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let Some(entry) = st.registry.tasks.get_mut(task_id) else {
            return;
        };
        if entry.record.status.is_terminal() {
            return; // already finalized (e.g. shutdown force-pass)
        }
        let code = status.and_then(|s| s.code());
        let signal = status.and_then(|s| s.signal());
        let now = now_ms();
        entry.record.exit_code = code;
        entry.record.signal = signal.map(signal_name);
        entry.record.ended_at = Some(now);
        entry.record.output_size = entry.output.lock().unwrap().total_size;
        entry.record.status = registry::terminal_status(entry.kill_requested, code, signal);
        if let Err(e) = registry::persist_record(&home, &entry.record) {
            lifecycle::log_line(&home, &format!("persist {} failed: {e}", entry.record.task_id));
        }
        let _ = entry.status_tx.send(entry.record.status);
        let event = EventKind::TaskExited {
            task_id: task_id.to_string(),
            exit_code: code,
            signal: entry.record.signal.clone(),
            duration_ms: now.saturating_sub(entry.record.started_at),
            output_path: entry.record.output_path.clone(),
            output_size: entry.record.output_size,
            ts: now,
        };
        (entry.record.session_id.clone(), event)
    };
    send_event_to_session(state, &sid, event);
}

// ---------------------------------------------------------------------------
// Graceful shutdown (§3.2)
// ---------------------------------------------------------------------------

async fn graceful_shutdown(state: &Shared) {
    let home = state.lock().unwrap().home.clone();
    lifecycle::log_line(&home, "graceful shutdown: terminating running tasks");

    // 1) SIGTERM every running process group.
    let pids: Vec<u32> = {
        let mut st = state.lock().unwrap();
        st.registry
            .tasks
            .values_mut()
            .filter(|e| e.record.status == TaskStatus::Running)
            .map(|e| {
                e.kill_requested = true; // disk state must say `killed` (§3.2)
                e.record.pid
            })
            .collect()
    };
    for pid in &pids {
        let _ = task::signal_group(*pid, task::SIGTERM);
    }
    if !pids.is_empty() {
        // 2) 2s grace, then SIGKILL the survivors.
        tokio::time::sleep(KILL_GRACE).await;
        let survivors: Vec<u32> = {
            state
                .lock()
                .unwrap()
                .registry
                .tasks
                .values()
                .filter(|e| e.record.status == TaskStatus::Running)
                .map(|e| e.record.pid)
                .collect()
        };
        for pid in survivors {
            let _ = task::signal_group(pid, task::SIGKILL);
        }
        // Let exit watchers / adopted pollers observe and persist.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // 3) Force-finalize anything still marked running (safety net; the
    //    kill reason "manager_shutdown" goes to manager.log — TaskRecord's
    //    field set is contractual, §3.4).
    {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let now = now_ms();
        for e in st.registry.tasks.values_mut() {
            if e.record.status == TaskStatus::Running {
                e.record.status = TaskStatus::Killed;
                e.record.ended_at = Some(now);
                e.record.output_size = e.output.lock().unwrap().total_size;
                if let Err(err) = registry::persist_record(&home, &e.record) {
                    lifecycle::log_line(
                        &home,
                        &format!("persist {} failed: {err}", e.record.task_id),
                    );
                }
                let _ = e.status_tx.send(TaskStatus::Killed);
            }
        }
    }
    if !pids.is_empty() {
        lifecycle::log_line(
            &home,
            &format!("killed {} task(s) (reason: manager_shutdown)", pids.len()),
        );
    }
    // Let pending responses (e.g. the shutdown ack) flush to clients.
    tokio::time::sleep(Duration::from_millis(250)).await;
    // 4) Remove socket/pid files and exit (§3.2).
    let _ = lifecycle::cleanup_stale_files(&home);
    lifecycle::log_line(&home, "shutdown complete");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("abc-DEF_123.x"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../escape"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("a b"));
        assert!(!valid_session_id(&"x".repeat(200)));
    }
}
