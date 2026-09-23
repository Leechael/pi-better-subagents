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
use std::collections::{HashMap, HashSet};
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
/// Server-side cap on raw bytes for one output read.
const MAX_OUTPUT_READ: u64 = 1024 * 1024;
/// Cap on a chunk's JSON-escaped size (control bytes escape to 6 bytes each),
/// leaving room for the response envelope inside the 4 MiB frame.
const CHUNK_JSON_BUDGET: usize = MAX_FRAME_SIZE as usize - 64 * 1024;
/// Poll interval for a process group that outlived its runner (fallback
/// only: normally the runner guards its group and its exit says "empty").
const GROUP_POLL: Duration = Duration::from_millis(500);

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
    pub extension_version: Option<String>,
    pub protocol: Option<u32>,
    pub connected_at: u64,
    pub last_seen: u64,
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
    /// Time source for the daemon's own timers (see `clock.rs`).
    pub clock: crate::clock::Clock,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(home: PathBuf, foreground: bool) -> i32 {
    if let Err(e) = std::fs::create_dir_all(&home) {
        eprintln!("pbs-manager: cannot create {}: {e}", home.display());
        return 1;
    }
    // §3.1: the lifetime lock on manager.lock decides who the daemon is; the
    // holder removes stale socket/pid files before binding. Held until exit.
    let _daemon_lock = match lifecycle::claim_daemon(&home) {
        Ok(Claim::Acquired(guard)) => guard,
        Ok(Claim::AlreadyRunning { pid }) => {
            match pid {
                Some(pid) => println!("pbs-manager already running (pid {pid})"),
                None => println!("pbs-manager already running (starting up)"),
            }
            return 0;
        }
        Err(e) => {
            eprintln!("pbs-manager: daemon lock failed: {e}");
            return 1;
        }
    };

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
        clock: crate::clock::Clock::from_env(),
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
            "daemon started pid={} version={} orphaned={} loaded={}",
            std::process::id(),
            env!("CARGO_PKG_VERSION"),
            scan.orphaned,
            scan.loaded
        ),
    );
    crate::events::emit(
        &home,
        None,
        "daemon.start",
        None,
        serde_json::json!({
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL,
            "orphaned": scan.orphaned,
            "loaded": scan.loaded,
        }),
    );
    if foreground {
        eprintln!(
            "pbs-manager {} listening on {} (pid {})",
            env!("CARGO_PKG_VERSION"),
            sock.display(),
            std::process::id()
        );
    }

    // §3.2: forget gone sessions past their retention, now and periodically.
    spawn_session_gc(&state);

    // §3.2: the idle rule applies from boot (clients connect within 2s of
    // spawn per §3.1, so this never fires for a healthy startup).
    maybe_arm_idle_timer(&state);

    let shutdown_notify = state.lock().unwrap().shutdown_notify.clone();
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).ok();

    // Keep accepting while shutting down: a new client then gets a prompt
    // "manager is shutting down" instead of hanging until its hello timeout
    // (and, under `test-clock`, can still step the manual clock).
    let mut shutdown_task: Option<tokio::task::JoinHandle<()>> = None;
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
            _ = shutdown_notify.notified(), if shutdown_task.is_none() => {
                shutdown_task = Some(begin_shutdown(&state));
            }
            _ = async {
                match sigterm.as_mut() {
                    Some(s) => { s.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            }, if shutdown_task.is_none() => {
                lifecycle::log_line(&home, "received SIGTERM");
                shutdown_task = Some(begin_shutdown(&state));
            }
            _ = async {
                match sigint.as_mut() {
                    Some(s) => { s.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            }, if shutdown_task.is_none() => {
                lifecycle::log_line(&home, "received SIGINT");
                shutdown_task = Some(begin_shutdown(&state));
            }
            _ = async {
                match shutdown_task.as_mut() {
                    Some(t) => { let _ = t.await; }
                    None => std::future::pending::<()>().await,
                }
            } => break,
        }
    }
    0
}

/// Mark the manager as shutting down (new hellos are refused) and run the
/// graceful shutdown as its own task.
fn begin_shutdown(state: &Shared) -> tokio::task::JoinHandle<()> {
    state.lock().unwrap().shutdown = true;
    let s = state.clone();
    tokio::spawn(async move { graceful_shutdown(&s).await })
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
        // An oversized frame is dropped, not written: write_frame would
        // refuse it, and ending the writer here would leave the connection
        // mute for every later response. `respond` already substitutes an
        // error for oversized responses, so this is a last line of defence.
        if payload.len() > MAX_FRAME_SIZE as usize {
            continue;
        }
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
    // Test-only manual-clock requests: answered before (instead of) hello,
    // so they never count as an active connection or cancel the idle timer.
    #[cfg(feature = "test-clock")]
    if matches!(hello.kind, RequestKind::ClockStatus | RequestKind::ClockAdvance { .. }) {
        respond(&tx, &hello.id, handle_clock(&state, &hello.kind)).await;
        return;
    }
    #[cfg(feature = "test-clock")]
    if matches!(hello.kind, RequestKind::DebugCrash) {
        std::process::exit(101);
    }
    if matches!(hello.v, Some(v) if v != PROTO_VERSION) {
        let _ = tx
            .send(encode_error(&hello.id, E_VERSION, "unsupported protocol version"))
            .await;
        return;
    }
    let (client_kind, session_id, pi_pid, info) = match hello.kind {
        RequestKind::Hello {
            client_kind,
            session_id,
            pi_pid,
            cwd,
            extension_version,
            protocol,
        } => (
            client_kind,
            session_id,
            pi_pid,
            HelloInfo {
                cwd,
                extension_version,
                protocol,
            },
        ),
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

    let conn_id = match register_conn(&state, &tx, &die, client_kind, session_id, pi_pid, info) {
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
        remove_conn(&mut st, conn_id, "closed");
    }
    maybe_arm_idle_timer(&state);
}

/// Optional hello fields stored per session.
pub struct HelloInfo {
    pub cwd: Option<String>,
    pub extension_version: Option<String>,
    pub protocol: Option<u32>,
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
    info: HelloInfo,
) -> Result<u64, ProtoError> {
    let mut st = state.lock().unwrap();
    if st.shutdown {
        return Err(ProtoError::new(E_INTERNAL, SHUTTING_DOWN));
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
            remove_conn(&mut st, old_id, "rebound");
        }
        let now = now_ms();
        // `connected_at` is the first hello this manager saw for the session;
        // a reconnect (pi --resume, rebind) keeps it.
        let connected_at = st.sessions.get(&sid).map(|s| s.connected_at).unwrap_or(now);
        crate::events::emit(
            &st.home,
            Some(&sid),
            "session.connect",
            None,
            serde_json::json!({
                "pi_pid": pi_pid.unwrap_or(0),
                "cwd": info.cwd,
                "extension_version": info.extension_version,
                "protocol": info.protocol,
            }),
        );
        st.sessions.insert(
            sid,
            SessionEntry {
                pi_pid: pi_pid.unwrap_or(0),
                conn_id: Some(conn_id),
                cwd: info.cwd,
                extension_version: info.extension_version,
                protocol: info.protocol,
                connected_at,
                last_seen: now,
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

fn remove_conn(st: &mut DaemonState, conn_id: u64, why: &str) {
    if let Some(h) = st.conns.remove(&conn_id) {
        if let Some(sid) = &h.session_id {
            let home = st.home.clone();
            if let Some(s) = st.sessions.get_mut(sid) {
                if s.conn_id == Some(conn_id) {
                    s.conn_id = None; // session now disconnected (§3.2)
                    s.last_seen = now_ms();
                    crate::events::emit(
                        &home,
                        Some(sid),
                        "session.disconnect",
                        None,
                        serde_json::json!({ "reason": why }),
                    );
                }
            }
        }
        for t in st.registry.tasks.values_mut() {
            t.watchers.remove(&conn_id);
        }
    }
}

/// §3.2: sweep gone sessions at startup and then every
/// `gc::interval_ms(retention)`. The retention is read once per daemon.
fn spawn_session_gc(state: &Shared) {
    let (home, clock) = {
        let st = state.lock().unwrap();
        (st.home.clone(), st.clock.clone())
    };
    let retention = match crate::gc::retention_ms(&home) {
        Ok(ms) => ms,
        Err(e) => {
            lifecycle::log_line(&home, &format!("config: {e}; using the default 24h"));
            crate::gc::DEFAULT_RETENTION_MS
        }
    };
    run_session_gc(state, retention);
    let state2 = state.clone();
    tokio::spawn(async move {
        let every = Duration::from_millis(crate::gc::interval_ms(retention));
        loop {
            clock.sleep("gc", every).await;
            if state2.lock().unwrap().shutdown {
                break;
            }
            run_session_gc(&state2, retention);
        }
    });
}

fn run_session_gc(state: &Shared, retention_ms: u64) {
    let mut st = state.lock().unwrap();
    // Never sweep a session that is connected or still owns live processes.
    let mut keep: HashSet<String> = st
        .sessions
        .iter()
        .filter(|(_, s)| s.conn_id.is_some())
        .map(|(sid, _)| sid.clone())
        .collect();
    for e in st.registry.tasks.values() {
        if e.record.status == TaskStatus::Running || e.owns_live_group() {
            keep.insert(e.record.session_id.clone());
        }
    }
    let home = st.home.clone();
    let removed = crate::gc::sweep(&home, &keep, retention_ms);
    if removed.is_empty() {
        return;
    }
    let gone: HashSet<&String> = removed.iter().collect();
    st.registry.tasks.retain(|_, e| !gone.contains(&e.record.session_id));
    st.sessions.retain(|sid, _| !gone.contains(sid));
    lifecycle::log_line(
        &home,
        &format!("gc: removed {} gone session(s): {}", removed.len(), removed.join(" ")),
    );
    crate::events::emit(
        &home,
        None,
        "session.gc",
        None,
        serde_json::json!({ "removed": removed, "retention_ms": retention_ms }),
    );
}

/// §3.2: arm the 5s idle timer when the last active connection went away.
fn maybe_arm_idle_timer(state: &Shared) {
    let mut st = state.lock().unwrap();
    if st.shutdown || !st.conns.is_empty() || st.idle_timer.is_some() {
        return;
    }
    let state2 = state.clone();
    let clock = st.clock.clone();
    st.idle_timer = Some(tokio::spawn(async move {
        clock.sleep("idle", IDLE_SHUTDOWN).await;
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
            origin,
            ..
        } => {
            let spec = StartSpec {
                kind,
                command,
                cwd,
                env,
                timeout_ms,
                origin,
            };
            respond(&tx, &id, handle_start(&state, conn_id, spec)).await
        }
        RequestKind::MarkBackground { task_id } => {
            respond(&tx, &id, handle_mark_background(&state, conn_id, &task_id)).await
        }
        RequestKind::Wait { task_id, budget_ms } => {
            respond(&tx, &id, handle_wait(&state, conn_id, &task_id, budget_ms).await).await
        }
        RequestKind::Output {
            task_id,
            cursor,
            max_bytes,
        } => respond(&tx, &id, handle_output(&state, conn_id, &task_id, cursor, max_bytes)).await,
        RequestKind::Stop { task_id, reason } => {
            respond(&tx, &id, handle_stop(&state, conn_id, &task_id, reason.as_deref())).await
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
        #[cfg(feature = "test-clock")]
        ref k @ (RequestKind::ClockStatus | RequestKind::ClockAdvance { .. }) => {
            respond(&tx, &id, handle_clock(&state, k)).await
        }
        #[cfg(feature = "test-clock")]
        RequestKind::DebugCrash => std::process::exit(101),
    }
}

/// Test-only: inspect or advance the manual clock (`test-clock` feature).
#[cfg(feature = "test-clock")]
fn handle_clock(state: &Shared, req: &RequestKind) -> Result<crate::clock::ClockStatus, ProtoError> {
    let clock = state.lock().unwrap().clock.clone();
    let Some(m) = clock.manual() else {
        return Err(ProtoError::new(
            E_BAD_REQUEST,
            "manual clock not enabled (start the daemon with PBS_TEST_CLOCK=manual)",
        ));
    };
    Ok(match req {
        RequestKind::ClockAdvance { ms } => m.advance(*ms),
        _ => m.status(),
    })
}

async fn respond<T: Serialize>(tx: &OutTx, id: &str, result: Result<T, ProtoError>) {
    let mut frame = match result {
        Ok(body) => encode_ok(id, &body),
        Err(e) => encode_error(id, &e.code, &e.message),
    };
    // Every request gets an answer: a response that does not fit a frame
    // becomes an error instead of silently disappearing.
    if frame.len() > MAX_FRAME_SIZE as usize {
        frame = encode_error(id, E_INTERNAL, "response exceeds the 4 MiB frame limit");
    }
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

pub struct StartSpec {
    pub kind: TaskKind,
    pub command: String,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
    pub origin: Option<Origin>,
}

fn handle_start(state: &Shared, conn_id: u64, spec: StartSpec) -> Result<StartOk, ProtoError> {
    let StartSpec {
        kind,
        command,
        cwd,
        env,
        timeout_ms,
        origin,
    } = spec;
    let (session_id, home) = {
        let st = state.lock().unwrap();
        if st.shutdown {
            return Err(ProtoError::new(E_INTERNAL, SHUTTING_DOWN));
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
        status,
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
        origin: origin.clone(),
        backgrounded_at: None,
        end_reason: None,
    };
    if let Err(e) = registry::persist_record(&home, &record) {
        let _ = task::signal_group(pid, task::SIGKILL); // don't leak the child
        return Err(ProtoError::new(E_INTERNAL, format!("persist failed: {e}")));
    }

    {
        // `task.start` is written before the task becomes visible, and so
        // before its exit can be watched and logged (see finalize_exit).
        let mut st = state.lock().unwrap();
        crate::events::emit(
            &home,
            Some(&session_id),
            "task.start",
            Some(&task_id),
            serde_json::json!({
                "kind": kind,
                "command": crate::events::clip_chars(&command, crate::events::COMMAND_CHARS),
                "origin": origin,
                "pid": pid,
            }),
        );
        let mut entry = TaskEntry::new_running(record, child, status, output, chunks, timeout_ms);
        // A monitor exists to stream: its starter watches from spawn on, so a
        // command that prints and exits at once loses nothing to a late watch.
        if kind == TaskKind::Monitor {
            entry.watchers.insert(conn_id);
        }
        st.registry.tasks.insert(task_id.clone(), entry);
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
    // Read a little past the cap so a character straddling it is visible.
    let want = cap + task::UTF8_LOOKAHEAD;
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
            Src::Ring(out.ring.slice(skip, avail.min(want)))
        } else {
            Src::Disk(e.record.output_path.clone())
        };
        (src, e.record.status, e.record.exit_code, total)
    };
    let mut bytes = match src {
        Src::Ring(b) => b,
        Src::Disk(path) => {
            task::read_file_range(std::path::Path::new(&path), cursor, want)
                .map_err(|e| ProtoError::new(E_INTERNAL, format!("read output: {e}")))?
                .0
        }
    };
    // §3.3: cut at a UTF-8 boundary, within the frame budget after escaping.
    // A truncated sequence at the end of the data is held back while the task
    // can still write the rest. (One straddling the cap never looks truncated:
    // the lookahead always holds the whole character.)
    let n = task::utf8_chunk_len(&bytes, cap, CHUNK_JSON_BUDGET, status == TaskStatus::Running);
    bytes.truncate(n);
    let next_cursor = cursor + bytes.len() as u64;
    Ok(OutputOk {
        chunk: String::from_utf8_lossy(&bytes).into_owned(), // §3.3: UTF-8 lossy
        next_cursor,
        status,
        exit_code,
        total_size,
    })
}

fn handle_stop(
    state: &Shared,
    conn_id: u64,
    task_id: &str,
    reason: Option<&str>,
) -> Result<UnitOk, ProtoError> {
    if let Some(r) = reason {
        if !STOP_REASONS.contains(&r) {
            return Err(ProtoError::new(
                E_BAD_REQUEST,
                format!("unknown stop reason {r:?} (expected one of {})", STOP_REASONS.join(", ")),
            ));
        }
    }
    let (pid, home, sid) = {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let acc = access_for(&st, conn_id);
        let e = st.registry.visible_mut(task_id, &acc)?;
        if !e.owns_live_group() {
            return Ok(UnitOk {}); // idempotent: terminal and nothing left
        }
        // A terminal task with a lingering group keeps its status; stop
        // still takes down what it left behind.
        e.request_kill(&end_reason_for_stop(reason));
        (e.record.pid, home, e.record.session_id.clone())
    };
    crate::events::emit(
        &home,
        Some(&sid),
        "task.stop",
        Some(task_id),
        serde_json::json!({ "reason": reason.unwrap_or("tool") }),
    );
    // §3.3 stop: SIGTERM the process group, 2s grace, then SIGKILL.
    let _ = task::signal_group(pid, task::SIGTERM);
    spawn_kill_reaper(state, task_id, pid);
    Ok(UnitOk {})
}

/// Observability: record that the extension moved a task to the background.
/// Idempotent (the first time is kept); a no-op on a finished task.
fn handle_mark_background(state: &Shared, conn_id: u64, task_id: &str) -> Result<UnitOk, ProtoError> {
    let (home, rec) = {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let acc = access_for(&st, conn_id);
        let e = st.registry.visible_mut(task_id, &acc)?;
        if e.record.status != TaskStatus::Running || e.record.backgrounded_at.is_some() {
            return Ok(UnitOk {});
        }
        e.record.backgrounded_at = Some(now_ms());
        let rec = e.record.clone();
        // Under the lock, like task.exit: the line cannot fall after a
        // concurrent exit's, nor after anyone sees `backgrounded_at`.
        crate::events::emit(
            &home,
            Some(&rec.session_id),
            "task.background",
            Some(task_id),
            serde_json::json!({ "after_ms": rec.backgrounded_at.unwrap_or(0).saturating_sub(rec.started_at) }),
        );
        (home, rec)
    };
    if let Err(e) = registry::persist_record(&home, &rec) {
        lifecycle::log_line(&home, &format!("persist {} failed: {e}", rec.task_id));
    }
    Ok(UnitOk {})
}

/// After the grace, SIGKILL the *group* if anything in it may survive: the
/// leader, or descendants that ignored SIGTERM after the leader died.
fn spawn_kill_reaper(state: &Shared, task_id: &str, pid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    let clock = state.lock().unwrap().clock.clone();
    tokio::spawn(async move {
        clock.sleep("kill-grace", KILL_GRACE).await;
        let group_live = {
            state2
                .lock()
                .unwrap()
                .registry
                .tasks
                .get(&tid)
                .map(|e| e.owns_live_group())
                .unwrap_or(false)
        };
        if group_live {
            let _ = task::signal_group(pid, task::SIGKILL);
        }
    });
}

/// Track a process group whose leader exited while members remain, until the
/// group empties. Polling keeps the pgid ours: POSIX does not reuse a pid
/// while a group with that id exists.
fn spawn_group_watcher(state: &Shared, task_id: &str, pgid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    let clock = state.lock().unwrap().clock.clone();
    tokio::spawn(async move {
        loop {
            clock.sleep("group-poll", GROUP_POLL).await;
            if crate::sys::group_has_others(pgid) {
                continue;
            }
            if let Some(e) = state2.lock().unwrap().registry.tasks.get_mut(&tid) {
                e.group_lingering = false;
            }
            break;
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
    let (victims, home, sid) = {
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
        // (task_id, pgid, was_running): lingering groups of finished tasks are
        // killed too, but only running tasks are reported as stopped.
        let mut v = Vec::new();
        for e in st.registry.tasks.values_mut() {
            if e.record.session_id == sid && e.owns_live_group() {
                let running = e.record.status == TaskStatus::Running;
                if running {
                    e.request_kill(end_reason::SESSION_END);
                }
                v.push((e.record.task_id.clone(), e.record.pid, running));
            }
        }
        (v, st.home.clone(), sid)
    };
    for (tid, pid, running) in &victims {
        if *running {
            crate::events::emit(
                &home,
                Some(&sid),
                "task.stop",
                Some(tid),
                serde_json::json!({ "reason": "session-end" }),
            );
        }
        let _ = task::signal_group(*pid, task::SIGTERM);
        spawn_kill_reaper(state, tid, *pid);
    }
    Ok(ShutdownSessionOk {
        stopped: victims
            .into_iter()
            .filter(|(_, _, running)| *running)
            .map(|(t, _, _)| t)
            .collect(),
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
            extension_version: s.extension_version.clone(),
            protocol: s.protocol,
            connected_at: s.connected_at,
            last_seen: if s.conn_id.is_some() { now_ms() } else { s.last_seen },
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
        protocol: PROTOCOL,
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
// Background tasks: output fanout, exit watch
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
        // Pipe reads split UTF-8 sequences arbitrarily. Hold an incomplete
        // trailing sequence back and prepend it to the next read, so events
        // never carry U+FFFD for valid text; `next_cursor` points at the
        // first byte not yet sent. The remainder is flushed at EOF.
        let mut carry: Vec<u8> = Vec::new();
        let mut last_cursor = 0u64;
        loop {
            let (bytes, next_cursor) = match rx.recv().await {
                Some(c) => {
                    last_cursor = c.next_cursor;
                    let mut data = std::mem::take(&mut carry);
                    data.extend_from_slice(&c.bytes);
                    let n = task::utf8_chunk_len(&data, usize::MAX, CHUNK_JSON_BUDGET, true);
                    carry = data.split_off(n);
                    (data, c.next_cursor - carry.len() as u64)
                }
                None if !carry.is_empty() => (std::mem::take(&mut carry), last_cursor),
                None => break,
            };
            let chunk = task::OutputChunk { bytes, next_cursor };
            let targets: Vec<OutTx> = {
                let mut st = state2.lock().unwrap();
                let watcher_ids: Vec<u64> = match st.registry.tasks.get_mut(&tid) {
                    Some(e) => {
                        e.record.output_size = last_cursor; // monotonic (§3.4)
                        e.watchers.iter().copied().collect()
                    }
                    None => break,
                };
                watcher_ids
                    .iter()
                    .filter_map(|cid| st.conns.get(cid).map(|h| h.tx.clone()))
                    .collect()
            };
            if !targets.is_empty() && !chunk.bytes.is_empty() {
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

/// How a task's process ended, as far as we could observe it.
#[derive(Clone, Copy)]
struct Outcome {
    code: Option<i32>,
    signal: Option<i32>,
}

impl Outcome {
    fn of(status: Option<std::process::ExitStatus>) -> Self {
        Outcome {
            code: status.and_then(|s| s.code()),
            signal: status.and_then(|s| s.signal()),
        }
    }
}

/// What may be left of the task's process group once its command ended.
enum Leftover {
    /// Nothing: the runner saw an empty group.
    None,
    /// Descendants remain; the runner guards them and its exit means empty.
    Guarded,
    /// Unknown (the runner died without reporting): probe the group.
    Probe,
}

enum FirstSeen {
    Report(Option<crate::runner::Reported>),
    RunnerExit(Option<std::process::ExitStatus>),
}

/// Read the runner's status line (see `crate::runner`). `line` keeps a
/// partial read across calls. None at EOF without a well-formed line.
async fn read_status_line(
    rx: &mut tokio::net::unix::pipe::Receiver,
    line: &mut Vec<u8>,
) -> Option<crate::runner::Reported> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 64];
    loop {
        if let Some(i) = line.iter().position(|b| *b == b'\n') {
            return crate::runner::parse_status(std::str::from_utf8(&line[..i]).ok()?);
        }
        match rx.read(&mut buf).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => line.extend_from_slice(&buf[..n]),
        }
    }
}

/// Await the task's end (or the hard timeout), then finalize the record.
///
/// The runner reports the command's real status on its status pipe, and its
/// own exit means its process group is empty (§3.4). Without a report (the
/// runner was SIGKILLed with its group, e.g. after a stop grace or the
/// timeout), the runner's wait status stands in: it died of the same
/// signal as the group.
fn spawn_exit_watch(state: &Shared, task_id: &str, pid: u32) {
    let state2 = state.clone();
    let tid = task_id.to_string();
    tokio::spawn(async move {
        let (child, status_rx, timeout_ms) = {
            let mut st = state2.lock().unwrap();
            match st.registry.tasks.get_mut(&tid) {
                Some(e) => (e.child.take(), e.status_rx.take(), e.timeout_ms),
                None => (None, None, None),
            }
        };
        let (Some(mut child), Some(mut status_rx)) = (child, status_rx) else { return };
        let mut line = Vec::new();
        let first = {
            let wait = child.wait();
            tokio::pin!(wait);
            let report = read_status_line(&mut status_rx, &mut line);
            tokio::pin!(report);
            let timeout = async {
                match timeout_ms {
                    Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
                    None => std::future::pending().await,
                }
            };
            tokio::pin!(timeout);
            let mut timed_out = false;
            loop {
                tokio::select! {
                    r = &mut report => break FirstSeen::Report(r),
                    s = &mut wait => break FirstSeen::RunnerExit(s.ok()),
                    _ = &mut timeout, if !timed_out => {
                        // §3.3: timeout_ms is a hard kill ceiling.
                        timed_out = true;
                        {
                            let mut st = state2.lock().unwrap();
                            if let Some(e) = st.registry.tasks.get_mut(&tid) {
                                if e.record.status == TaskStatus::Running {
                                    e.request_kill(end_reason::TIMEOUT);
                                }
                            }
                        }
                        let _ = task::signal_group(pid, task::SIGKILL);
                    }
                }
            }
        };
        match first {
            FirstSeen::Report(Some(r)) => {
                let outcome = Outcome { code: r.code, signal: r.signal };
                if r.linger {
                    finalize_exit(&state2, &tid, outcome, Leftover::Guarded);
                    // The runner exits once the group is empty.
                    let _ = child.wait().await;
                    if let Some(e) = state2.lock().unwrap().registry.tasks.get_mut(&tid) {
                        e.group_lingering = false;
                    }
                } else {
                    finalize_exit(&state2, &tid, outcome, Leftover::None);
                    let _ = child.wait().await; // reap the runner
                }
            }
            FirstSeen::Report(None) => {
                let s = child.wait().await.ok();
                finalize_exit(&state2, &tid, Outcome::of(s), Leftover::Probe);
            }
            FirstSeen::RunnerExit(s) => {
                // A report written just before the runner exited may still
                // be in the pipe; the write end is closed now, so this ends.
                match read_status_line(&mut status_rx, &mut line).await {
                    Some(r) => {
                        let leftover = if r.linger { Leftover::Probe } else { Leftover::None };
                        finalize_exit(&state2, &tid, Outcome { code: r.code, signal: r.signal }, leftover);
                    }
                    None => finalize_exit(&state2, &tid, Outcome::of(s), Leftover::Probe),
                }
            }
        }
    });
}

/// Map an observed exit to a terminal status, persist the record, wake
/// `wait`ers, and push `task_exited` to the owning session (§3.3/§3.4).
fn finalize_exit(state: &Shared, task_id: &str, outcome: Outcome, leftover: Leftover) {
    let mut lingering = None;
    let (sid, event) = {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let Some(entry) = st.registry.tasks.get_mut(task_id) else {
            return;
        };
        if entry.record.status.is_terminal() {
            return; // already finalized (e.g. shutdown force-pass)
        }
        let Outcome { code, signal } = outcome;
        let now = now_ms();
        entry.record.exit_code = code;
        entry.record.signal = signal.map(signal_name);
        entry.record.ended_at = Some(now);
        entry.record.output_size = entry.output.lock().unwrap().total_size;
        entry.record.status = registry::terminal_status(entry.kill_requested, code, signal);
        // Why it ended: our kill's reason; otherwise a natural exit.
        entry.record.end_reason = Some(
            entry
                .kill_reason
                .clone()
                .unwrap_or_else(|| end_reason::EXITED.to_string()),
        );
        if let Err(e) = registry::persist_record(&home, &entry.record) {
            lifecycle::log_line(&home, &format!("persist {} failed: {e}", entry.record.task_id));
        }
        // The command is gone; descendants it backgrounded may not be.
        let pgid = entry.record.pid;
        match leftover {
            Leftover::None => {}
            Leftover::Guarded => entry.group_lingering = true,
            Leftover::Probe => {
                if crate::sys::group_has_others(pgid) {
                    entry.group_lingering = true;
                    lingering = Some(pgid);
                }
            }
        }
        let event = EventKind::TaskExited {
            task_id: task_id.to_string(),
            exit_code: code,
            signal: entry.record.signal.clone(),
            duration_ms: now.saturating_sub(entry.record.started_at),
            output_path: entry.record.output_path.clone(),
            output_size: entry.record.output_size,
            ts: now,
            end_reason: entry.record.end_reason.clone(),
        };
        // The events.jsonl line goes first, still under the state lock: once
        // anyone can see the task as finished (`wait`, `list`), `task.exit`
        // is on disk, ahead of whatever that observer does next.
        let sid = entry.record.session_id.clone();
        log_task_exit(&home, &sid, &event);
        let _ = entry.status_tx.send(entry.record.status);
        (sid, event)
    };
    if let Some(pgid) = lingering {
        spawn_group_watcher(state, task_id, pgid);
    }
    send_event_to_session(state, &sid, event);
}

/// events.jsonl `task.exit` from a task_exited event.
fn log_task_exit(home: &std::path::Path, sid: &str, ev: &EventKind) {
    if let EventKind::TaskExited {
        task_id,
        exit_code,
        signal,
        duration_ms,
        end_reason,
        ..
    } = ev
    {
        crate::events::emit(
            home,
            Some(sid),
            "task.exit",
            Some(task_id),
            serde_json::json!({
                "exit_code": exit_code,
                "signal": signal,
                "end_reason": end_reason,
                "duration_ms": duration_ms,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Graceful shutdown (§3.2)
// ---------------------------------------------------------------------------

/// Re-probe every leftover group (`TaskEntry::refresh_lingering`). Returns
/// whether any still lingers.
fn refresh_lingering_groups(state: &Shared) -> bool {
    let mut st = state.lock().unwrap();
    let mut any = false;
    for e in st.registry.tasks.values_mut() {
        any |= e.refresh_lingering();
    }
    any
}

async fn graceful_shutdown(state: &Shared) {
    let home = state.lock().unwrap().home.clone();
    lifecycle::log_line(&home, "graceful shutdown: terminating running tasks");

    // 0) Look at leftover groups as they are now, not as the last group
    //    poll saw them: a group that has emptied needs no SIGTERM and must
    //    not hold shutdown in the grace (under the manual test clock the
    //    poll never runs unstepped, so a stale flag would hold it forever).
    //    Right after its leader is reaped, `kill(-pgid, 0)` can answer EPERM
    //    for a moment (macOS, seen under load), so a group that still looks
    //    alive gets a second probe after a short real-time pause.
    if refresh_lingering_groups(state) {
        tokio::time::sleep(Duration::from_millis(20)).await;
        refresh_lingering_groups(state);
    }

    // 1) SIGTERM every process group that may have members: running tasks,
    //    and finished tasks whose leader left descendants behind (§3.2).
    let (pids, running): (Vec<u32>, usize) = {
        let mut st = state.lock().unwrap();
        let mut running = 0;
        let pids = st
            .registry
            .tasks
            .values_mut()
            .filter(|e| e.owns_live_group())
            .map(|e| {
                if e.record.status == TaskStatus::Running {
                    e.request_kill(end_reason::MANAGER_SHUTDOWN); // disk says `killed` (§3.2)
                    running += 1;
                }
                e.record.pid
            })
            .collect();
        (pids, running)
    };
    for pid in &pids {
        let _ = task::signal_group(*pid, task::SIGTERM);
    }
    if !pids.is_empty() {
        // 2) 2s grace, then SIGKILL every group that may still have members,
        //    even if its leader already died (SIGTERM-ignoring descendants).
        let clock = state.lock().unwrap().clock.clone();
        clock.sleep("shutdown-grace", KILL_GRACE).await;
        // A group that emptied during the grace is no longer ours to signal.
        refresh_lingering_groups(state);
        let survivors: Vec<u32> = {
            state
                .lock()
                .unwrap()
                .registry
                .tasks
                .values()
                .filter(|e| e.owns_live_group())
                .map(|e| e.record.pid)
                .collect()
        };
        for pid in survivors {
            let _ = task::signal_group(pid, task::SIGKILL);
        }
        // Let exit watchers observe and persist.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // 3) Force-finalize anything still marked running (safety net), with
    //    end_reason "manager-shutdown" (also in manager.log below).
    {
        let mut st = state.lock().unwrap();
        let home = st.home.clone();
        let now = now_ms();
        for e in st.registry.tasks.values_mut() {
            if e.record.status == TaskStatus::Running {
                e.record.status = TaskStatus::Killed;
                e.record.ended_at = Some(now);
                e.record.output_size = e.output.lock().unwrap().total_size;
                e.record.end_reason = Some(
                    e.kill_reason
                        .clone()
                        .unwrap_or_else(|| end_reason::MANAGER_SHUTDOWN.to_string()),
                );
                if let Err(err) = registry::persist_record(&home, &e.record) {
                    lifecycle::log_line(
                        &home,
                        &format!("persist {} failed: {err}", e.record.task_id),
                    );
                }
                let ev = EventKind::TaskExited {
                    task_id: e.record.task_id.clone(),
                    exit_code: None,
                    signal: None,
                    duration_ms: now.saturating_sub(e.record.started_at),
                    output_path: e.record.output_path.clone(),
                    output_size: e.record.output_size,
                    ts: now,
                    end_reason: e.record.end_reason.clone(),
                };
                log_task_exit(&home, &e.record.session_id, &ev);
                let _ = e.status_tx.send(TaskStatus::Killed);
            }
        }
    }
    if running > 0 {
        lifecycle::log_line(
            &home,
            &format!("killed {running} task(s) (reason: manager_shutdown)"),
        );
    }
    if pids.len() > running {
        lifecycle::log_line(
            &home,
            &format!(
                "killed {} leftover process group(s) of finished tasks (reason: manager_shutdown)",
                pids.len() - running
            ),
        );
    }
    // Let pending responses (e.g. the shutdown ack) flush to clients.
    tokio::time::sleep(Duration::from_millis(250)).await;
    // 4) Remove socket/pid files and exit (§3.2).
    let _ = lifecycle::cleanup_stale_files(&home);
    crate::events::emit(
        &home,
        None,
        "daemon.shutdown",
        None,
        serde_json::json!({ "pid": std::process::id(), "killed_tasks": running }),
    );
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
