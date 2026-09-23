//! Event log (observability contract).
//!
//! `<home>/sessions/<session_id>/events.jsonl` is append-only, one JSON object
//! per line, written by both the manager and the extension. Session-less
//! daemon events (`daemon.start`, `daemon.shutdown`) go to
//! `<home>/events.jsonl`. Every line carries `ts` (ms epoch), `src`
//! ("manager" | "extension"), `type`, optional `id`, plus type-specific
//! fields, and is shorter than 4 KiB including its newline: oversized string
//! fields are truncated (and `"truncated":true` is added) so a line can be
//! written with a single O_APPEND write and never interleave with another
//! writer's line.

use serde_json::{Map, Value};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Every line, newline included, is strictly shorter than this.
pub const MAX_LINE: usize = 4096;
/// `task.start` keeps at most this many characters of the command.
pub const COMMAND_CHARS: usize = 200;

pub fn session_events_path(home: &Path, session_id: &str) -> PathBuf {
    home.join("sessions").join(session_id).join("events.jsonl")
}

pub fn daemon_events_path(home: &Path) -> PathBuf {
    home.join("events.jsonl")
}

/// First `max` characters of `s` (with "…" when cut).
pub fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
    t.push('…');
    t
}

/// Serialize one event line (without the trailing newline), truncating string
/// fields until the line plus newline fits in [`MAX_LINE`].
pub fn encode_line(ts: u64, src: &str, ty: &str, id: Option<&str>, fields: Value) -> Vec<u8> {
    let mut obj = Map::new();
    obj.insert("ts".into(), Value::from(ts));
    obj.insert("src".into(), Value::from(src));
    obj.insert("type".into(), Value::from(ty));
    if let Some(id) = id {
        obj.insert("id".into(), Value::from(id));
    }
    if let Value::Object(extra) = fields {
        for (k, v) in extra {
            // Common fields are never overridden by type-specific ones.
            obj.entry(k).or_insert(v);
        }
    }
    let mut v = Value::Object(obj);
    let mut truncated = false;
    for _ in 0..64 {
        let line = serde_json::to_vec(&v).expect("event serialization");
        if line.len() + 1 < MAX_LINE {
            return line;
        }
        let excess = line.len() + 1 - (MAX_LINE - 1);
        if !shrink_longest_string(&mut v, excess + 32) {
            break;
        }
        if !truncated {
            truncated = true;
            if let Value::Object(o) = &mut v {
                o.insert("truncated".into(), Value::Bool(true));
            }
        }
    }
    // Nothing left to shrink (pathological: huge keys or arrays of numbers):
    // keep only the common fields.
    let mut o = Map::new();
    o.insert("ts".into(), Value::from(ts));
    o.insert("src".into(), Value::from(src));
    o.insert("type".into(), Value::from(clip_chars(ty, 64)));
    if let Some(id) = id {
        o.insert("id".into(), Value::from(clip_chars(id, 128)));
    }
    o.insert("truncated".into(), Value::Bool(true));
    serde_json::to_vec(&Value::Object(o)).expect("event serialization")
}

/// Cut the longest string leaf by at least `by` bytes (at a char boundary),
/// never touching `src`/`type`/`ts`. Returns false when no string can shrink.
fn shrink_longest_string(v: &mut Value, by: usize) -> bool {
    fn longest<'a>(v: &'a mut Value, top: bool, best: &mut Option<&'a mut String>) {
        match v {
            Value::String(s) => {
                if best.as_ref().map_or(true, |b| s.len() > b.len()) {
                    *best = Some(s);
                }
            }
            Value::Array(a) => {
                for x in a {
                    longest(x, false, best);
                }
            }
            Value::Object(o) => {
                for (k, x) in o.iter_mut() {
                    if top && (k == "src" || k == "type") {
                        continue;
                    }
                    longest(x, false, best);
                }
            }
            _ => {}
        }
    }
    let mut best: Option<&mut String> = None;
    longest(v, true, &mut best);
    let Some(s) = best else { return false };
    if s.len() <= 1 {
        return false;
    }
    let mut keep = s.len().saturating_sub(by + 3); // room for "…"
    while keep > 0 && !s.is_char_boundary(keep) {
        keep -= 1;
    }
    s.truncate(keep);
    s.push('…');
    true
}

/// Append one line with a single O_APPEND write.
pub fn append_line(path: &Path, line: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line);
    buf.push(b'\n');
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    // One write call for the whole line (< 4 KiB): an O_APPEND write of this
    // size lands contiguously, so lines from concurrent writers never mix.
    let n = f.write(&buf)?;
    if n != buf.len() {
        f.write_all(&buf[n..])?;
    }
    Ok(())
}

/// Manager-side emit: best effort, never fails the caller.
pub fn emit(home: &Path, session_id: Option<&str>, ty: &str, id: Option<&str>, fields: Value) {
    let path = match session_id {
        Some(sid) => session_events_path(home, sid),
        None => daemon_events_path(home),
    };
    let line = encode_line(crate::proto::now_ms(), "manager", ty, id, fields);
    let _ = append_line(&path, &line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn line_has_common_fields_and_fits() {
        let l = encode_line(5, "manager", "task.start", Some("sh_1"), json!({"kind":"shell"}));
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!(v, json!({"ts":5,"src":"manager","type":"task.start","id":"sh_1","kind":"shell"}));
        // type-specific fields cannot override common ones
        let l = encode_line(5, "manager", "x", None, json!({"type":"evil","ts":1}));
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!((v["type"].as_str(), v["ts"].as_u64()), (Some("x"), Some(5)));
    }

    #[test]
    fn oversized_fields_are_truncated_below_4k() {
        let big = "字".repeat(5000); // 15000 bytes
        let l = encode_line(1, "manager", "task.start", Some("sh_1"), json!({"command": big, "origin": {"child_id": "c".repeat(3000)}}));
        assert!(l.len() + 1 < MAX_LINE, "{}", l.len());
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["type"], "task.start");
        assert!(v["command"].as_str().unwrap().ends_with('…'));
        // A small line is not marked truncated.
        let l = encode_line(1, "manager", "t", None, json!({"a":"b"}));
        assert!(serde_json::from_slice::<Value>(&l).unwrap().get("truncated").is_none());
        // Pathological: many numbers, nothing to shrink -> common fields only.
        let nums: Vec<u64> = (0..2000).collect();
        let l = encode_line(1, "manager", "t", Some("i"), json!({ "n": nums }));
        assert!(l.len() + 1 < MAX_LINE);
        let v: Value = serde_json::from_slice(&l).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["id"], "i");
    }
}
