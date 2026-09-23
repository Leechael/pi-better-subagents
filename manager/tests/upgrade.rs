//! In-place upgrade (design doc §3.2, `handover.rs`): the daemon execs the
//! binary now at its path, with the same pid, and every task keeps running.
//!
//! Each test runs its daemon from a private copy of the binary
//! (`Home::install_copy`), so replacing that file never affects other tests.
//! Runs in both clock modes; the timers stepped here (`kill-grace`) are
//! re-armed by the new image and stepped the same way.

mod common;

use common::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn s(secs: u64) -> Duration {
    Duration::from_secs(secs)
}

fn hello(c: &mut Conn, session: &str) {
    c.request_ok(json!({"type":"hello","client_kind":"extension","session_id":session,
        "pi_pid":std::process::id(),"cwd":"/tmp","protocol":2}));
}

fn start(c: &mut Conn, kind: &str, command: &str, extra: Value) -> (String, u32) {
    let mut req = json!({"type":"start","kind":kind,"command":command,"cwd":"/tmp","env":{"PATH":PATH_ENV}});
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    c.start_with(req)
}

fn status(home: &Home) -> Value {
    let out = home.cli(&["status", "--json"], s(10));
    serde_json::from_str(&out.stdout).unwrap_or_else(|e| {
        let log = std::fs::read_to_string(home.path.join("manager.log")).unwrap_or_default();
        panic!("status --json ({e}): {} {}\nmanager.log:\n{log}", out.stdout, out.stderr)
    })
}

fn upgrade(home: &Home) -> CliOut {
    home.cli(&["upgrade"], s(40))
}

/// Pids in process group `pgid` (the runner and what it started).
fn group(pgid: u32) -> Vec<u32> {
    let out = std::process::Command::new("pgrep").arg("-g").arg(pgid.to_string()).output().unwrap();
    String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|p| p.parse().ok()).collect()
}

/// Every `output` event's text for `task_id`, in arrival order.
fn event_text(events: &[Value], task_id: &str) -> String {
    events
        .iter()
        .filter(|e| e["event"] == "output" && e["task_id"] == task_id)
        .map(|e| e["chunk"].as_str().unwrap_or("").to_string())
        .collect()
}

/// Numbered lines `prefix-0 prefix-1 …` with no gap and no repeat.
fn assert_sequential(text: &str, prefix: &str, what: &str) -> usize {
    let lines: Vec<&str> = text.split_whitespace().collect();
    for (i, l) in lines.iter().enumerate() {
        assert_eq!(*l, format!("{prefix}-{i}"), "{what}: line {i} out of sequence in {text:?}");
    }
    lines.len()
}

/// The core promise: an upgrade is invisible to running work.
#[test]
fn u1_upgrade_keeps_every_task_running() {
    let home = Home::new("u1");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let before = status(&home);
    let mut c = home.connect();
    hello(&mut c, "sess-u1");

    // Streams numbered lines for ~3 s, then exits 7.
    let (stream, stream_pid) = start(&mut c, "shell",
        "i=0; while [ $i -lt 300 ]; do echo line-$i; i=$((i+1)); sleep 0.01; done; exit 7", json!({}));
    // A monitor, auto-watched by this connection.
    let (mon, _) = start(&mut c, "monitor",
        "i=0; while [ $i -lt 250 ]; do echo mon-$i; i=$((i+1)); sleep 0.02; done", json!({}));
    let (sleeper, sleeper_pid) = start(&mut c, "shell", "sleep 300", json!({}));
    // Finishes at once, leaving a grandchild its runner guards.
    let (leftover, leftover_pid) = start(&mut c, "shell", "sleep 300 & exit 0", json!({}));
    // Hard timeout 4 s after start, straddling the upgrade.
    let (timed, _) = start(&mut c, "shell", "sleep 300", json!({"timeout_ms": 4000}));
    c.wait_event(s(5), |e| e["event"] == "task_exited" && e["task_id"] == leftover).expect("leftover task exits");
    let sleeper_group = group(sleeper_pid);
    let leftover_group = group(leftover_pid);
    assert!(leftover_group.len() >= 2, "runner + grandchild: {leftover_group:?}");
    // A wait in flight when the upgrade starts.
    c.send(&json!({"v":1,"id":"inflight-wait","type":"wait","task_id":sleeper,"budget_ms":20000}));
    std::thread::sleep(Duration::from_millis(300));

    let out = upgrade(&home);
    assert!(out.status.success(), "upgrade failed: {} {}", out.stdout, out.stderr);
    assert!(out.stdout.contains("upgraded in place"), "{}", out.stdout);

    // The old connection was closed; the in-flight wait got no answer (the
    // client resends it), certainly not an error.
    assert!(c.wait_closed(s(5)), "connection not closed by the upgrade");
    assert!(c.pending.iter().all(|f| f["id"] != "inflight-wait"), "in-flight wait was answered: {:?}", c.pending);

    let after = status(&home);
    assert_eq!(after["pid"], before["pid"], "same pid");
    assert_eq!(after["generation"], 1);
    assert_eq!(after["last_upgrade"]["ok"], true);
    assert_eq!(after["last_upgrade"]["trigger"], "cli");
    for p in sleeper_group.iter().chain(&leftover_group) {
        assert!(pid_alive(*p), "pid {p} died in the upgrade");
    }

    // Reconnect as the same session: the monitor subscription comes back
    // with what was missed, and continues.
    let mut c2 = home.connect();
    hello(&mut c2, "sess-u1");
    let w = c2.request_ok(json!({"type":"wait","task_id":stream,"budget_ms":15000}));
    assert_eq!((w["done"].as_bool(), w["exit_code"].as_i64()), (Some(true), Some(7)), "real exit code: {w}");
    let file = std::fs::read_to_string(home.path.join(format!("sessions/sess-u1/tasks/{stream}.output"))).unwrap();
    assert_eq!(assert_sequential(&file, "line", "stream output"), 300);
    assert!(!pid_alive(stream_pid) || group(stream_pid).is_empty());

    let w = c2.request_ok(json!({"type":"wait","task_id":mon,"budget_ms":15000}));
    assert_eq!(w["done"], true);
    c2.wait_event(s(3), |e| e["event"] == "task_exited" && e["task_id"] == mon);
    let mut events = c.events.clone();
    events.extend(c2.events.clone());
    let n = assert_sequential(&event_text(&events, &mon), "mon", "monitor events across the upgrade");
    assert_eq!(n, 250, "every monitor line delivered exactly once");

    // The timeout set before the upgrade still fires, from its original start.
    let t = c2.wait_terminal(&timed, s(8)).expect("timed task ends");
    assert_eq!((t["status"].as_str(), t["end_reason"].as_str()), (Some("killed"), Some("timeout")), "{t}");

    // Stop still works, including on a guarded leftover group.
    c2.request_ok(json!({"type":"stop","task_id":sleeper}));
    c2.request_ok(json!({"type":"stop","task_id":leftover}));
    home.advance("kill-grace", 2_000);
    let t = c2.wait_terminal(&sleeper, s(5)).unwrap();
    assert_eq!((t["status"].as_str(), t["end_reason"].as_str()), (Some("killed"), Some("stopped:tool")));
    assert!(poll_true(s(5), || sleeper_group.iter().chain(&leftover_group).all(|p| !pid_running(*p))),
        "stopped groups gone: {:?} {:?}", group(sleeper_pid), group(leftover_pid));
}

/// Old extensions stay loaded in running pi processes after an upgrade:
/// the new daemon accepts the previous protocol (and none).
#[test]
fn u2_old_protocol_hello_after_upgrade() {
    let home = Home::new("u2");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u2-keep");
    let out = upgrade(&home);
    assert!(out.status.success(), "{} {}", out.stdout, out.stderr);
    for (sid, proto) in [("sess-u2-p1", json!(1)), ("sess-u2-none", Value::Null)] {
        let mut c = home.connect();
        let mut h = json!({"type":"hello","client_kind":"extension","session_id":sid,"pi_pid":std::process::id()});
        if !proto.is_null() {
            h["protocol"] = proto;
        }
        c.request_ok(h);
        let (t, _) = start(&mut c, "shell", "echo hi", json!({}));
        let r = c.wait_terminal(&t, s(5)).unwrap();
        assert_eq!(r["exit_code"], 0, "{sid}: {r}");
    }
}

/// A start resent with the same key after a lost connection returns the task
/// it already started; another session's key is its own.
#[test]
fn u3_start_key_makes_a_resent_start_idempotent() {
    let home = Home::new("u3");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u3");
    let (a, _) = start(&mut c, "shell", "sleep 300", json!({"key":"k-1"}));
    assert!(upgrade(&home).status.success());
    let mut c2 = home.connect();
    hello(&mut c2, "sess-u3");
    let (b, _) = start(&mut c2, "shell", "sleep 300", json!({"key":"k-1"}));
    assert_eq!(a, b, "same key, same task (carried across the upgrade)");
    let mut other = home.connect();
    hello(&mut other, "sess-u3-other");
    let (o, _) = start(&mut other, "shell", "sleep 300", json!({"key":"k-1"}));
    assert_ne!(o, a, "keys are per session");
}

/// A binary that fails the preflight changes nothing: no connection is
/// closed, no task is touched, and the failure is reported.
#[test]
fn u4_bad_binary_is_refused_before_anything_changes() {
    let home = Home::new("u4");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u4");
    let (t, pid) = start(&mut c, "monitor", "i=0; while true; do echo m-$i; i=$((i+1)); sleep 0.05; done", json!({}));
    let bad = home.path.join("bad");
    std::fs::write(&bad, "#!/bin/sh\nexit 3\n").unwrap();
    std::fs::set_permissions(&bad, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    replace_binary(&bin, &bad);
    let out = upgrade(&home);
    assert!(!out.status.success(), "{}", out.stdout);
    assert!(out.stderr.contains("upgrade not done") && out.stderr.contains("not an upgrade target"), "{}", out.stderr);
    let st = status(&home);
    assert_eq!((st["generation"].as_u64(), st["last_upgrade"]["ok"].as_bool()), (Some(0), Some(false)), "{st}");
    // The same connection still works and still streams.
    let before = event_text(&c.events, &t).len();
    c.request_ok(json!({"type":"list"}));
    std::thread::sleep(Duration::from_millis(400));
    c.request_ok(json!({"type":"list"}));
    assert!(event_text(&c.events, &t).len() > before, "monitor kept streaming on the same connection");
    assert!(pid_alive(pid));
    // A file that is not executable is refused the same way.
    replace_binary(&bin, std::path::Path::new(BIN));
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
    let out = upgrade(&home);
    assert!(!out.status.success() && out.stderr.contains("cannot run"), "{}", out.stderr);
    assert_eq!(status(&home)["generation"], 0);
    assert!(pid_alive(pid));
}

/// exec itself failing after the quiesce: everything resumes on the old
/// image with no byte lost (test hook PBS_TEST_EXEC_PATH).
#[test]
fn u5_failed_exec_rolls_back() {
    let home = Home::new("u5");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[("PBS_TEST_EXEC_PATH", "/nonexistent/pbs-manager")]);
    let mut c = home.connect();
    hello(&mut c, "sess-u5");
    let (t, pid) = start(&mut c, "monitor",
        "i=0; while [ $i -lt 150 ]; do echo m-$i; i=$((i+1)); sleep 0.02; done", json!({}));
    std::thread::sleep(Duration::from_millis(500));
    let out = upgrade(&home);
    assert!(!out.status.success(), "{}", out.stdout);
    assert!(out.stderr.contains("exec /nonexistent"), "{}", out.stderr);
    assert!(c.wait_closed(s(5)), "connections are closed by the quiesce");
    let mut c2 = home.connect();
    hello(&mut c2, "sess-u5");
    let w = c2.request_ok(json!({"type":"wait","task_id":t,"budget_ms":15000}));
    assert_eq!(w["done"], true);
    c2.wait_event(s(3), |e| e["event"] == "task_exited" && e["task_id"] == t);
    let mut events = c.events.clone();
    events.extend(c2.events.clone());
    assert_eq!(assert_sequential(&event_text(&events, &t), "m", "events across a rollback"), 150);
    let st = status(&home);
    assert_eq!(st["generation"], 0);
    assert_eq!(st["last_upgrade"]["ok"], false);
    assert!(!pid_alive(pid) || group(pid).is_empty());
}

/// The new image failing to restore is a crash: the lifeline closes and
/// every task and grandchild is cleaned up (no crash recovery).
#[test]
fn u6_failed_restore_cleans_up_like_a_crash() {
    let home = Home::new("u6");
    let bin = home.install_copy();
    let d = home.start_daemon_from(&bin, &[("PBS_TEST_FAIL_RESTORE", "1")]);
    let mut c = home.connect();
    hello(&mut c, "sess-u6");
    let (_t, pid) = start(&mut c, "shell", "sleep 300 & sleep 300", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    let members = group(pid);
    assert!(members.len() >= 3, "runner, sh, sleeps: {members:?}");
    let out = upgrade(&home);
    assert!(!out.status.success(), "{}", out.stdout);
    assert!(out.stderr.contains("exited during the upgrade"), "{}", out.stderr);
    let mut d = d;
    assert!(wait_child(&mut d, s(5)).is_some(), "daemon exited");
    assert!(poll_true(s(5), || members.iter().all(|p| !pid_running(*p))), "left alive: {:?}", group(pid));
}

/// Replacing the binary file is enough: the daemon notices and upgrades.
#[test]
fn u7_replacing_the_binary_upgrades_by_itself() {
    let home = Home::new("u7");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u7");
    let (_t, pid) = start(&mut c, "shell", "sleep 300", json!({}));
    let before = status(&home);
    replace_binary(&bin, std::path::Path::new(BIN));
    let deadline = Instant::now() + s(15);
    let after = loop {
        std::thread::sleep(Duration::from_millis(250));
        let st = status(&home);
        if st["generation"] == 1 {
            break st;
        }
        assert!(Instant::now() < deadline, "no automatic upgrade: {st}");
    };
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(after["last_upgrade"]["trigger"], "binary-changed");
    assert!(pid_alive(pid));
}

/// A stop's kill grace pending across the upgrade still ends in SIGKILL for
/// a command that ignores SIGTERM.
#[test]
fn u8_kill_grace_carries_over() {
    let home = Home::new("u8");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u8");
    let (t, pid) = start(&mut c, "shell", "trap '' TERM; sleep 300 & wait; sleep 300", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    c.request_ok(json!({"type":"stop","task_id":t}));
    assert!(upgrade(&home).status.success());
    let members = group(pid);
    // On the manual clock the grace cannot elapse during the upgrade, so the
    // group must still be there and only the re-armed grace can end it. On
    // real time a slow upgrade (parallel load) may outlast the 2 s; the
    // outcome below must hold either way.
    if home.manual {
        assert!(!members.is_empty(), "SIGTERM-ignoring group still there after the upgrade\nmanager.log:\n{}",
            std::fs::read_to_string(home.path.join("manager.log")).unwrap_or_default());
    }
    // The new image re-armed the grace with what was left of it.
    home.advance_partial("kill-grace", 2_000);
    assert!(poll_true(s(5), || members.iter().all(|p| !pid_running(*p))), "not killed: {:?}", group(pid));
    let mut c2 = home.connect();
    hello(&mut c2, "sess-u8");
    let r = c2.wait_terminal(&t, s(5)).unwrap();
    assert_eq!((r["status"].as_str(), r["end_reason"].as_str()), (Some("killed"), Some("stopped:tool")), "{r}");
}

/// CLI commands in progress (`wait`, `output -f`) ride through an upgrade:
/// their request is resent on a new connection.
#[test]
fn u9_cli_wait_and_follow_survive_an_upgrade() {
    let home = Home::new("u9");
    let bin = home.install_copy();
    let _d = home.start_daemon_from(&bin, &[]);
    let mut c = home.connect();
    hello(&mut c, "sess-u9");
    let (t, _) = start(&mut c, "shell",
        "i=0; while [ $i -lt 60 ]; do echo f-$i; i=$((i+1)); sleep 0.05; done; exit 3", json!({}));
    let (h1, h2) = (home.path.clone(), home.path.clone());
    let (t1, t2) = (t.clone(), t.clone());
    let wait = std::thread::spawn(move || run_cli(&h1, &["wait", &t1, "--budget-ms", "20000"], s(30)));
    let follow = std::thread::spawn(move || run_cli(&h2, &["output", &t2, "-f"], s(30)));
    std::thread::sleep(Duration::from_millis(700));
    assert!(upgrade(&home).status.success());
    let w = wait.join().unwrap();
    assert!(w.status.success() && w.stdout.contains("done exit_code=3"), "wait: {} {}", w.stdout, w.stderr);
    let f = follow.join().unwrap();
    assert!(f.status.success(), "output -f: {}", f.stderr);
    assert_eq!(assert_sequential(&f.stdout, "f", "output -f across the upgrade"), 60);
    assert_eq!(status(&home)["generation"], 1);
}
