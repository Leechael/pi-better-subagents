//! Wire protocol: frame codec and message types (design doc §3.3).
//!
//! Frame format: `u32 BE length + UTF-8 JSON payload`, max frame 4 MiB.
//! Requests:  `{"v":1, "id":"<uuid>", "type":"...", ...}`
//! Responses: `{"v":1, "id":"<uuid>", "ok":true, ...}` or
//!            `{"v":1, "id":"...", "ok":false, "error":{"code":"E_*","message":"..."}}`
//! Events (server push, no id): `{"v":1, "type":"event", "event":"...", ...}`

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTO_VERSION: u32 = 1;
/// §3.3: max frame 4 MiB.
pub const MAX_FRAME_SIZE: u32 = 4 * 1024 * 1024;

// Error codes (§3.3).
pub const E_NOT_FOUND: &str = "E_NOT_FOUND";
pub const E_BAD_REQUEST: &str = "E_BAD_REQUEST";
pub const E_VERSION: &str = "E_VERSION";
pub const E_SESSION_REQUIRED: &str = "E_SESSION_REQUIRED";
pub const E_FORBIDDEN: &str = "E_FORBIDDEN";
pub const E_INTERNAL: &str = "E_INTERNAL";

/// Epoch milliseconds; used for started_at/ended_at/ts fields everywhere.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Shared enums & records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Extension,
    Cli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Shell,
    Monitor,
}

impl TaskKind {
    /// §3.3: task_id prefix — `sh` (shell) / `mon` (monitor).
    pub fn prefix(self) -> &'static str {
        match self {
            TaskKind::Shell => "sh",
            TaskKind::Monitor => "mon",
        }
    }
}

/// §3.4 task state machine: running -> completed | failed | killed | orphaned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Killed,
    Orphaned,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, TaskStatus::Running)
    }
}

/// §3.4: TaskRecord persisted at sessions/<sid>/tasks/<task_id>.json.
/// Field set is contractual — do not add/remove fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub task_id: String,
    pub session_id: String,
    pub kind: TaskKind,
    pub command: String,
    pub cwd: String,
    pub pid: u32,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub output_path: String,
    pub output_size: u64,
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// §3.3 framing says requests carry `"v":1`, but the doc's hello example
    /// omits it. Lenient read: absent == current version; present must match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
    /// §3.3 hello example also omits id; it is then echoed as "".
    #[serde(default)]
    pub id: String,
    #[serde(flatten)]
    pub kind: RequestKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequestKind {
    /// §3.3 hello — must be the first message on a connection.
    Hello {
        client_kind: ClientKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pi_pid: Option<u32>,
        /// Session working directory. Optional so older clients still hello.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// §3.3 start — env is the child's *complete* environment.
    Start {
        kind: TaskKind,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        #[serde(default)]
        run_in_background: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Wait {
        task_id: String,
        budget_ms: u64,
    },
    Output {
        task_id: String,
        cursor: u64,
        max_bytes: u64,
    },
    Stop {
        task_id: String,
    },
    List {
        #[serde(default)]
        all: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    Watch {
        task_id: String,
    },
    Unwatch {
        task_id: String,
    },
    ShutdownSession,
    Status,
    Shutdown,
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/// Generic response envelope; `T` is the success payload (flattened).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response<T> {
    pub v: u32,
    pub id: String,
    pub ok: bool,
    #[serde(flatten)]
    pub body: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtoError {
    pub code: String,
    pub message: String,
}

impl ProtoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        ProtoError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ProtoError,
}

/// Empty success payload: renders as just `{"v":1,"id":"...","ok":true}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitOk {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloOk {
    pub version: String,
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartOk {
    pub task_id: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitOk {
    pub done: bool,
    /// §3.3: present on done:true; omitted when the budget expired (done:false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputOk {
    /// UTF-8 lossy chunk (§3.3: v1 has no binary fidelity).
    pub chunk: String,
    pub next_cursor: u64,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub total_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListOk {
    pub tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShutdownSessionOk {
    pub stopped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub pi_pid: u32,
    pub connected: bool,
    /// Present when the extension sent cwd on hello. Omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCounts {
    pub running: usize,
    pub terminal: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusOk {
    pub version: String,
    pub pid: u32,
    pub uptime_ms: u64,
    pub sessions: Vec<SessionInfo>,
    pub task_counts: TaskCounts,
}

// ---------------------------------------------------------------------------
// Events (server push, no id)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub v: u32,
    #[serde(rename = "type")]
    pub msg_type: String, // always "event"
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    pub fn new(kind: EventKind) -> Self {
        Event {
            v: PROTO_VERSION,
            msg_type: "event".to_string(),
            kind,
        }
    }
}

/// §3.3 event table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum EventKind {
    /// Always pushed to the owning session.
    TaskStarted {
        task_id: String,
        kind: TaskKind,
        command: String,
        pid: u32,
        ts: u64,
    },
    /// Only pushed after `watch`.
    Output {
        task_id: String,
        chunk: String,
        next_cursor: u64,
    },
    /// Always pushed to the owning session.
    TaskExited {
        task_id: String,
        exit_code: Option<i32>,
        signal: Option<i32>,
        duration_ms: u64,
        output_path: String,
        output_size: u64,
        ts: u64,
    },
    /// Pushed to the old connection when a session is rebound (§3.3 hello).
    SessionRebound {},
}

// ---------------------------------------------------------------------------
// Frame codec (§3.3)
// ---------------------------------------------------------------------------

/// Read one frame. Ok(None) = clean EOF (peer closed). Errors on oversized
/// frames and on EOF mid-payload.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {len} exceeds 4 MiB limit"),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Write one frame (length-prefixed, flushed).
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_SIZE as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload {} bytes exceeds 4 MiB limit", payload.len()),
        ));
    }
    w.write_all(&(payload.len() as u32).to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

/// Serialize a message to a frame payload. Infallible for the types in this
/// module (no custom serializers, string-keyed maps only).
pub fn encode<T: Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).expect("protocol message serialization is infallible")
}

// ---------------------------------------------------------------------------
// id / randomness helpers
// ---------------------------------------------------------------------------

/// Fill buf from /dev/urandom, falling back to a time/pid mix (unix targets).
pub fn random_bytes(buf: &mut [u8]) {
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(buf).is_ok() {
            return;
        }
    }
    // Fallback: hash of time + pid + address — good enough for id uniqueness.
    let mut x = now_ms() ^ (std::process::id() as u64) << 32 ^ (buf.as_ptr() as usize as u64);
    for b in buf.iter_mut() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = x as u8;
    }
}

/// RFC-4122 v4-shaped request id (§3.3: `"id":"<uuid>"`).
pub fn new_request_id() -> String {
    let mut b = [0u8; 16];
    random_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    let mut s = String::with_capacity(36);
    for (i, byte) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            s.push('-');
        }
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn frame_roundtrip() {
        let (mut a, mut b) = duplex(64 * 1024);
        let payload = br#"{"v":1,"id":"x","type":"status"}"#;
        write_frame(&mut a, payload).await.unwrap();
        let got = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(got, payload);
        drop(a);
        assert!(read_frame(&mut b).await.unwrap().is_none()); // clean EOF
    }

    #[tokio::test]
    async fn frame_over_limit_rejected() {
        let (mut a, mut b) = duplex(1024);
        // Reader rejects an announced length above 4 MiB.
        a.write_all(&(MAX_FRAME_SIZE + 1).to_be_bytes()).await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        // Writer refuses to send an oversized payload.
        let big = vec![0u8; MAX_FRAME_SIZE as usize + 1];
        let err = write_frame(&mut a, &big).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn hello_request_json_shape() {
        let req = Request {
            v: Some(1),
            id: "abc".into(),
            kind: RequestKind::Hello {
                client_kind: ClientKind::Extension,
                session_id: Some("sess1".into()),
                pi_pid: Some(1234),
                cwd: None,
            },
        };
        let v: serde_json::Value = serde_json::from_slice(&encode(&req)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "v": 1, "id": "abc", "type": "hello",
                "client_kind": "extension", "session_id": "sess1", "pi_pid": 1234
            })
        );
        // cli hello omits session fields entirely (§3.3).
        let req = Request {
            v: Some(1),
            id: "abc".into(),
            kind: RequestKind::Hello {
                client_kind: ClientKind::Cli,
                session_id: None,
                pi_pid: None,
                cwd: None,
            },
        };
        let v: serde_json::Value = serde_json::from_slice(&encode(&req)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"v": 1, "id": "abc", "type": "hello", "client_kind": "cli"})
        );
    }

    #[test]
    fn hello_without_v_and_id_is_accepted() {
        // The doc's hello examples (and the black-box tests built on them)
        // send hello with no v/id envelope at all.
        let raw = br#"{"type":"hello","client_kind":"extension","session_id":"s","pi_pid":1}"#;
        let req: Request = serde_json::from_slice(raw).unwrap();
        assert_eq!(req.v, None);
        assert_eq!(req.id, "");
        assert!(matches!(req.kind, RequestKind::Hello { .. }));
        let raw = br#"{"type":"hello","client_kind":"cli"}"#;
        let req: Request = serde_json::from_slice(raw).unwrap();
        assert!(matches!(
            req.kind,
            RequestKind::Hello {
                client_kind: ClientKind::Cli,
                ..
            }
        ));
    }

    #[test]
    fn start_request_parses_doc_example() {
        // §3.3 start example, plus the v/id envelope.
        let raw = br#"{"v":1,"id":"r1","type":"start","kind":"shell","command":"ls -la",
            "cwd":"/tmp","env":{"PATH":"/bin"},"run_in_background":false,"timeout_ms":null}"#;
        let req: Request = serde_json::from_slice(raw).unwrap();
        match req.kind {
            RequestKind::Start {
                kind,
                command,
                cwd,
                env,
                run_in_background,
                timeout_ms,
            } => {
                assert_eq!(kind, TaskKind::Shell);
                assert_eq!(command, "ls -la");
                assert_eq!(cwd.as_deref(), Some("/tmp"));
                assert_eq!(env.get("PATH").unwrap(), "/bin");
                assert!(!run_in_background);
                assert_eq!(timeout_ms, None);
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn error_response_shape() {
        let resp = Response {
            v: 1,
            id: "x".into(),
            ok: false,
            body: ErrorBody {
                error: ProtoError::new(E_NOT_FOUND, "no such task"),
            },
        };
        let v: serde_json::Value = serde_json::from_slice(&encode(&resp)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "v": 1, "id": "x", "ok": false,
                "error": {"code": "E_NOT_FOUND", "message": "no such task"}
            })
        );
    }

    #[test]
    fn wait_ok_omits_exit_code_when_budget_expired() {
        // §3.3: budget expiry responds {"ok":true,"done":false} — no exit_code key.
        let resp = Response {
            v: 1,
            id: "x".into(),
            ok: true,
            body: WaitOk {
                done: false,
                exit_code: None,
            },
        };
        let v: serde_json::Value = serde_json::from_slice(&encode(&resp)).unwrap();
        assert_eq!(v, serde_json::json!({"v": 1, "id": "x", "ok": true, "done": false}));
    }

    #[test]
    fn output_ok_keeps_null_exit_code() {
        // §3.3 output example shows "exit_code":null explicitly.
        let resp = Response {
            v: 1,
            id: "x".into(),
            ok: true,
            body: OutputOk {
                chunk: "hi".into(),
                next_cursor: 2,
                status: TaskStatus::Running,
                exit_code: None,
                total_size: 2,
            },
        };
        let v: serde_json::Value = serde_json::from_slice(&encode(&resp)).unwrap();
        assert_eq!(v["exit_code"], serde_json::Value::Null);
        assert_eq!(v["status"], serde_json::json!("running"));
    }

    #[test]
    fn event_shapes() {
        let ev = Event::new(EventKind::TaskExited {
            task_id: "sh_a1b2c3d4".into(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 42,
            output_path: "/tmp/x.output".into(),
            output_size: 7,
            ts: 1726000000000,
        });
        let v: serde_json::Value = serde_json::from_slice(&encode(&ev)).unwrap();
        assert_eq!(v["v"], serde_json::json!(1));
        assert_eq!(v["type"], serde_json::json!("event"));
        assert_eq!(v["event"], serde_json::json!("task_exited"));
        assert_eq!(v["task_id"], serde_json::json!("sh_a1b2c3d4"));
        assert!(v.get("id").is_none()); // events carry no id (§3.3)

        let ev = Event::new(EventKind::SessionRebound {});
        let v: serde_json::Value = serde_json::from_slice(&encode(&ev)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"v": 1, "type": "event", "event": "session_rebound"})
        );
    }

    #[test]
    fn request_id_is_uuid_shaped() {
        let id = new_request_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_ne!(new_request_id(), id);
    }

    #[test]
    fn task_id_prefixes() {
        assert_eq!(TaskKind::Shell.prefix(), "sh");
        assert_eq!(TaskKind::Monitor.prefix(), "mon");
    }
}
