//! Black-box tests for the observability contract (manager side): protocol
//! additions (origin, mark_background, stop.reason, end_reason, hello
//! extension_version/protocol, status protocol) and the manager's
//! events.jsonl writes.

mod common;

use common::*;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Duration;

const S: fn(u64) -> Duration = Duration::from_secs;
const MS: fn(u64) -> Duration = Duration::from_millis;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Extension-style hello that announces the current protocol.
fn hello_v2(c: &mut Conn, session: &str, cwd: &str) -> Value {
    c.request_ok(json!({"type":"hello","client_kind":"extension","session_id":session,
        "pi_pid":std::process::id(),"cwd":cwd,"extension_version":"0.9.0-test","protocol":2}))
}

fn start(c: &mut Conn, cmd: &str, extra: Value) -> (String, u32) {
    let mut req = json!({"type":"start","kind":"shell","command":cmd,"cwd":"/tmp","env":{"PATH":PATH_ENV}});
    if let (Some(o), Some(e)) = (req.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    c.start_with(req)
}

fn events_of(home: &Home, sid: &str) -> Vec<Value> {
    let p = home.path.join("sessions").join(sid).join("events.jsonl");
    std::fs::read_to_string(p)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad event line ({e}): {l}")))
        .collect()
}

fn wait_event(home: &Home, sid: &str, ty: &str, id: Option<&str>) -> Value {
    poll_until(S(5), || {
        events_of(home, sid)
            .into_iter()
            .find(|e| e["type"] == ty && id.map_or(true, |i| e["id"] == i))
    })
    .unwrap_or_else(|| panic!("no {ty} event for {id:?} in {sid}: {:?}", events_of(home, sid)))
}

/// start.origin is stored; mark_background records backgrounded_at once;
/// every way a task can end sets end_reason, and task_exited carries it.
#[test]
fn p1_origin_background_and_end_reasons() {
    let home = Home::new("p1");
    let _d = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-p1", "/tmp");

    let origin = json!({"via":"child-bash","child_id":"ch_0000beef","run_id":"run_0000cafe"});
    let (a, _) = start(&mut c, "sleep 300", json!({"origin": origin}));
    assert_eq!(c.task(&a).unwrap()["origin"], origin);

    let t0 = now_ms();
    c.request_ok(json!({"type":"mark_background","task_id":a}));
    let bg = c.task(&a).unwrap()["backgrounded_at"].as_u64().expect("backgrounded_at");
    assert!(bg >= t0 && bg <= now_ms() + 1000);
    std::thread::sleep(MS(20));
    c.request_ok(json!({"type":"mark_background","task_id":a}));
    assert_eq!(c.task(&a).unwrap()["backgrounded_at"].as_u64(), Some(bg), "first time is kept");
    assert_eq!(home.record(&a).unwrap()["backgrounded_at"].as_u64(), Some(bg), "persisted");

    // stop reasons
    let cases = [
        (Some("cli"), "stopped:cli"),
        (Some("tui"), "stopped:tui"),
        (Some("tool"), "stopped:tool"),
        (None, "stopped:tool"),
        (Some("timeout"), "timeout"),
        (Some("rate-limit"), "rate-limit"),
        (Some("session-end"), "session-end"),
    ];
    for (reason, want) in cases {
        let (id, _) = start(&mut c, "sleep 300", json!({}));
        let mut req = json!({"type":"stop","task_id":id});
        if let Some(r) = reason {
            req["reason"] = json!(r);
        }
        c.request_ok(req);
        let t = c.wait_terminal(&id, S(5)).unwrap();
        assert_eq!(t["end_reason"], want, "reason {reason:?}: {t}");
        assert_eq!(t["status"], "killed");
        let ev = c
            .wait_event(S(3), |e| e["event"] == "task_exited" && e["task_id"] == json!(id))
            .unwrap();
        assert_eq!(ev["end_reason"], want, "task_exited for {reason:?}: {ev}");
    }
    let r = c.request(json!({"type":"stop","task_id":a,"reason":"because"}));
    assert_eq!(r["error"]["code"], "E_BAD_REQUEST", "{r}");
    assert_eq!(c.status_of(&a).as_deref(), Some("running"), "a rejected stop does nothing");

    // natural exits (any code) and the hard timeout
    let (ok, _) = start(&mut c, "true", json!({}));
    let (bad, _) = start(&mut c, "exit 3", json!({}));
    let (slow, _) = start(&mut c, "sleep 300", json!({"timeout_ms": 200}));
    assert_eq!(c.wait_terminal(&ok, S(3)).unwrap()["end_reason"], "exited");
    assert_eq!(c.wait_terminal(&bad, S(3)).unwrap()["end_reason"], "exited");
    assert_eq!(c.wait_terminal(&slow, S(3)).unwrap()["end_reason"], "timeout");

    // shutdown_session: session-end
    let (x, _) = start(&mut c, "sleep 300", json!({}));
    c.request_ok(json!({"type":"shutdown_session"}));
    assert_eq!(c.wait_terminal(&x, S(5)).unwrap()["end_reason"], "session-end");
    assert_eq!(c.wait_terminal(&a, S(5)).unwrap()["end_reason"], "session-end");
    // The first reason wins: a task that ignores the cli stop's SIGTERM is
    // still running when shutdown_session arrives, and keeps "stopped:cli".
    let (y, _) = start(&mut c, "trap '' TERM; echo armed; sleep 300", json!({}));
    assert!(poll_true(S(3), || c.task(&y).unwrap()["output_size"].as_u64().unwrap_or(0) > 0));
    c.request_ok(json!({"type":"stop","task_id":y,"reason":"cli"}));
    c.request_ok(json!({"type":"shutdown_session"}));
    assert_eq!(c.wait_terminal(&y, S(6)).unwrap()["end_reason"], "stopped:cli");
}

/// manager-shutdown, orphaned and manager-restart end reasons.
#[test]
fn p2_end_reasons_across_manager_lifecycle() {
    let home = Home::new("p2");
    let mut d1 = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-p2", "/tmp");
    let (dead, dead_pid) = start(&mut c, "sleep 300", json!({}));
    let (late, late_pid) = start(&mut c, "sleep 300", json!({}));
    let (keep, _) = start(&mut c, "sleep 300", json!({}));
    drop(c);
    d1.kill().unwrap();
    d1.wait().unwrap();
    kill_group(dead_pid, libc::SIGKILL);
    assert!(poll_true(S(3), || !pid_running(dead_pid)));

    let mut d2 = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-p2", "/tmp");
    assert_eq!(c.task(&dead).unwrap()["end_reason"], "orphaned");
    let ev = wait_event(&home, "sess-p2", "task.exit", Some(&dead));
    assert_eq!(ev["end_reason"], "orphaned");
    kill_group(late_pid, libc::SIGKILL);
    let t = c.wait_terminal(&late, S(5)).unwrap();
    assert_eq!(t["end_reason"], "manager-restart", "{t}");
    drop(c);
    assert!(home.cli(&["shutdown"], S(10)).status.success());
    assert!(wait_child(&mut d2, S(10)).is_some());
    assert_eq!(home.record(&keep).unwrap()["end_reason"], "manager-shutdown");
    let ev = wait_event(&home, "sess-p2", "task.exit", Some(&keep));
    assert_eq!(ev["end_reason"], "manager-shutdown");
}

/// hello's extension_version/protocol are stored per session; status
/// returns the manager's protocol and session timing.
#[test]
fn p3_hello_protocol_and_status() {
    let home = Home::new("p3");
    let _d = home.start_daemon();
    let t0 = now_ms();
    let mut a = home.connect();
    hello_v2(&mut a, "sess-p3", "/tmp/p3");
    let mut cli = home.connect();
    cli.hello_cli();
    let st = cli.request_ok(json!({"type":"status"}));
    assert_eq!(st["protocol"], 2, "{st}");
    let s = &st["sessions"][0];
    assert_eq!((s["protocol"].as_u64(), s["extension_version"].as_str()), (Some(2), Some("0.9.0-test")), "{st}");
    let since = s["connected_at"].as_u64().unwrap();
    assert!(since >= t0 && since <= now_ms());
    drop(a);
    assert!(poll_true(S(3), || {
        let st = cli.request_ok(json!({"type":"status"}));
        st["sessions"][0]["connected"] == false
    }));
    let st = cli.request_ok(json!({"type":"status"}));
    let seen = st["sessions"][0]["last_seen"].as_u64().unwrap();
    assert!(seen >= since && seen <= now_ms(), "{st}");
    // reconnecting keeps the first connected_at
    let mut b = home.connect();
    hello_v2(&mut b, "sess-p3", "/tmp/p3");
    let st = cli.request_ok(json!({"type":"status"}));
    assert_eq!(st["sessions"][0]["connected_at"].as_u64(), Some(since));
}

#[test]
fn e1_manager_writes_session_and_task_events() {
    let home = Home::new("e1");
    let mut d = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-e1", "/tmp/e1");
    let long_cmd = format!("sleep 300 # {}", "x".repeat(1000));
    let (a, pid) = start(&mut c, &long_cmd, json!({"origin":{"via":"bash-fg"}}));
    c.request_ok(json!({"type":"mark_background","task_id":a}));
    c.request_ok(json!({"type":"stop","task_id":a,"reason":"tui"}));
    c.wait_terminal(&a, S(5)).unwrap();
    drop(c);
    assert!(wait_child(&mut d, S(12)).is_some());

    let evs = events_of(&home, "sess-e1");
    let types: Vec<&str> = evs.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        ["session.connect", "task.start", "task.background", "task.stop", "task.exit", "session.disconnect"],
        "{evs:#?}"
    );
    for e in &evs {
        assert_eq!(e["src"], "manager");
        assert!(e["ts"].as_u64().is_some());
    }
    assert_eq!(evs[0]["pi_pid"], std::process::id());
    assert_eq!(evs[0]["cwd"], "/tmp/e1");
    assert_eq!(evs[0]["protocol"], 2);
    let start = &evs[1];
    assert_eq!((start["id"].as_str(), start["kind"].as_str()), (Some(a.as_str()), Some("shell")));
    assert_eq!(start["origin"], json!({"via":"bash-fg"}));
    assert_eq!(start["pid"], pid);
    let cmd = start["command"].as_str().unwrap();
    assert_eq!(cmd.chars().count(), 200, "command clipped to 200 chars");
    assert!(cmd.ends_with('…'));
    assert_eq!(evs[3]["reason"], "tui");
    let exit = &evs[4];
    assert_eq!(exit["end_reason"], "stopped:tui");
    assert!(exit["signal"].is_string() && exit["exit_code"].is_null() && exit["duration_ms"].is_u64(), "{exit}");
    // daemon-level events live in <home>/events.jsonl
    let daemon: Vec<Value> = std::fs::read_to_string(home.path.join("events.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let dt: Vec<&str> = daemon.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(dt, ["daemon.start", "daemon.shutdown"]);
    assert_eq!(daemon[0]["protocol"], 2);
}

/// Oversized fields are truncated so every line stays below 4 KiB.
#[test]
fn e2_event_lines_stay_below_4k() {
    let home = Home::new("e2");
    let _d = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-e2", &"/tmp/".repeat(2000));
    let origin = json!({"via":"child-bash","child_id":"c".repeat(9000),"run_id":"r".repeat(9000)});
    let (a, _) = start(&mut c, "true", json!({"origin": origin}));
    c.wait_terminal(&a, S(3)).unwrap();
    wait_event(&home, "sess-e2", "task.exit", Some(&a));
    let raw = std::fs::read_to_string(home.path.join("sessions/sess-e2/events.jsonl")).unwrap();
    for line in raw.lines() {
        assert!(line.len() + 1 < 4096, "line of {} bytes", line.len());
        let v: Value = serde_json::from_str(line).unwrap();
        assert!(v["type"].is_string() && v["ts"].is_u64());
    }
    let start_ev = events_of(&home, "sess-e2").into_iter().find(|e| e["type"] == "task.start").unwrap();
    assert_eq!(start_ev["truncated"], true);
    assert_eq!(start_ev["id"], a, "the id is never truncated");
    let connect = events_of(&home, "sess-e2").into_iter().find(|e| e["type"] == "session.connect").unwrap();
    assert_eq!(connect["truncated"], true);
}

/// Concurrent appends from the manager and several extension-style writers
/// never interleave: every line parses and nothing is lost.
#[test]
fn e3_concurrent_appends_never_interleave() {
    let home = Home::new("e3");
    let _d = home.start_daemon();
    let mut c = home.connect();
    hello_v2(&mut c, "sess-e3", "/tmp");
    let path = home.path.join("sessions/sess-e3/events.jsonl");
    const WRITERS: usize = 8;
    const LINES: usize = 300;
    let writers: Vec<_> = (0..WRITERS)
        .map(|w| {
            let path = path.clone();
            std::thread::spawn(move || {
                for i in 0..LINES {
                    // ~1-3.5 KiB lines, written the way the extension must:
                    // one O_APPEND write per line.
                    let pad = "p".repeat(1000 + (i * 37 + w * 101) % 2500);
                    let line = format!(
                        "{}\n",
                        json!({"ts":now_ms(),"src":"extension","type":"wake.emit","id":format!("w{w}-{i}"),"ids":[format!("w{w}-{i}")],"pad":pad})
                    );
                    assert!(line.len() < 4096);
                    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
                    assert_eq!(f.write(line.as_bytes()).unwrap(), line.len());
                }
            })
        })
        .collect();
    // Meanwhile the manager writes its own events.
    let mut ids = Vec::new();
    for _ in 0..40 {
        ids.push(start(&mut c, "true", json!({})).0);
    }
    for w in writers {
        w.join().unwrap();
    }
    for id in &ids {
        c.wait_terminal(id, S(5)).unwrap();
    }
    for id in &ids {
        wait_event(&home, "sess-e3", "task.exit", Some(id));
    }
    let evs = events_of(&home, "sess-e3"); // panics on any malformed line
    let ext = evs.iter().filter(|e| e["src"] == "extension").count();
    let starts = evs.iter().filter(|e| e["type"] == "task.start").count();
    let exits = evs.iter().filter(|e| e["type"] == "task.exit").count();
    assert_eq!((ext, starts, exits), (WRITERS * LINES, 40, 40));
}
