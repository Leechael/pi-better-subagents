//! CLI stdout that exits quietly with status 0 when the reader goes away.
//!
//! Rust ignores SIGPIPE, so `pbs-manager output ID | head` used to make
//! `println!` panic (exit 101) once `head` closed the pipe. Every CLI line goes
//! through [`line`]/[`bytes`] instead: a broken pipe ends the process
//! silently with status 0, like a well-behaved Unix filter.

use std::io::{ErrorKind, Write};

pub fn bytes(b: &[u8]) {
    let stdout = std::io::stdout();
    let mut o = stdout.lock();
    if let Err(e) = o.write_all(b).and_then(|_| o.flush()) {
        if e.kind() == ErrorKind::BrokenPipe {
            std::process::exit(0);
        }
    }
}

pub fn line(s: &str) {
    let mut b = Vec::with_capacity(s.len() + 1);
    b.extend_from_slice(s.as_bytes());
    b.push(b'\n');
    bytes(&b);
}

/// `println!` replacement for CLI output.
#[macro_export]
macro_rules! outln {
    () => { $crate::out::line("") };
    ($($t:tt)*) => { $crate::out::line(&format!($($t)*)) };
}
