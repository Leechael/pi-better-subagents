//! The `pbs-manager` command-line contract, declared with usage-rs.

use std::path::PathBuf;

use crate::VERSION;

/// Process management daemon for pi-better-subagents.
// usage-rs emits a literal spec version; runtime `VERSION` also carries the git SHA.
#[derive(usage::Cli)]
#[usage(
    bin = "pbs-manager",
    version = VERSION,
    version_spec = "0.1.0",
    about = "Process management daemon for pi-better-subagents",
    unknown_flags = "error",
    args_override_self = false,
    completion
)]
pub(crate) struct Cli {
    /// Base directory. Priority: --home flag > PBS_HOME env > ~/.pi/agent/pbs (§3.1).
    #[usage(long, global)]
    pub(crate) home: Option<PathBuf>,
    /// Never page output. Otherwise listings on a terminal go through
    /// PBS_PAGER, else PAGER, else `less` (LESS=FRX unless set).
    #[usage(long, global)]
    pub(crate) no_pager: bool,
    #[usage(subcommand)]
    pub(crate) cmd: Sub,
}

impl Sub {
    /// Listings and dumps a person reads; not a follow, not an action.
    pub(crate) fn pages(&self) -> bool {
        match self {
            Sub::Sessions { .. } | Sub::List { .. } | Sub::Show { .. } => true,
            Sub::Agent { follow, .. } | Sub::Events { follow, .. } | Sub::Log { follow, .. } => {
                !follow
            }
            _ => false,
        }
    }
}

#[derive(usage::Subcommands)]
pub(crate) enum Sub {
    /// Run the manager daemon in the foreground (this is what clients spawn).
    Daemon {
        /// Also log to stderr (for debugging).
        #[usage(long)]
        foreground: bool,
        /// Internal: continue an in-place upgrade from this handover file.
        #[usage(long, hide)]
        handover: Option<PathBuf>,
    },
    /// Version, protocol, uptime, sessions, task and agent counts. Never
    /// starts the daemon ("pbs-manager is not running", exit 1).
    Status {
        #[usage(long)]
        json: bool,
    },
    /// Connected pi sessions (a gone session only while it still runs
    /// something). Gone sessions' records are kept for `goneSessionRetention`
    /// (config.json, default 24h) and stay reachable via show/agent/events.
    Sessions {
        #[usage(long)]
        json: bool,
    },
    /// Running tasks and agents, newest first. `--all` adds the finished
    /// work of connected sessions, after the running group. An agent's time
    /// is its last transcript message. Alias: `ls`.
    #[usage(alias = "ls")]
    List {
        /// Also list finished work of connected sessions.
        #[usage(short, long)]
        all: bool,
        /// Only sessions whose id starts with this prefix.
        #[usage(long)]
        session: Option<String>,
        /// Only work whose cwd is this directory or below it.
        #[usage(long)]
        cwd: Option<String>,
        /// Only work active within this long (e.g. 30s, 10m, 2h, 1d): a task's
        /// start, an agent's last message.
        #[usage(long)]
        since: Option<String>,
        #[usage(long)]
        json: bool,
    },
    /// Everything about one task, monitor, agent (ch_…) or run (run_…).
    Show {
        id: String,
        #[usage(long)]
        json: bool,
    },
    /// Render an agent's transcript (preamble hidden unless --full).
    Agent {
        id: String,
        /// Include the system prompt / agent preamble.
        #[usage(long)]
        full: bool,
        /// Keep following the transcript.
        #[usage(short = 'f', long)]
        follow: bool,
    },
    /// Event log, merged and time-ordered across sessions.
    Events {
        #[usage(short = 'f', long)]
        follow: bool,
        /// Only sessions whose id starts with this prefix.
        #[usage(long)]
        session: Option<String>,
        /// Only events about this task/agent id.
        #[usage(long)]
        id: Option<String>,
        /// Only events within this long (e.g. 30s, 10m, 2h).
        #[usage(long)]
        since: Option<String>,
        /// One raw JSON object per line.
        #[usage(long)]
        json: bool,
    },
    /// Read a task's output through the protocol; -f follows. For an agent
    /// id, prints its result.
    Output {
        task_id: String,
        /// Follow the output stream.
        #[usage(short = 'f', long)]
        follow: bool,
        /// Print at most this many bytes in total.
        #[usage(long)]
        max_bytes: Option<u64>,
    },
    /// Stop a task (SIGTERM group -> 2s -> SIGKILL).
    Stop { task_id: String },
    /// Stop all running tasks of a session.
    KillSession { session_id: String },
    /// Health checks (daemon, socket, config, protocol, stale records,
    /// orphan pids, disk use); fixes stale socket/pid files. Exit 1 on any
    /// failure.
    Doctor,
    /// Gracefully shut the manager down (kills remaining tasks).
    Shutdown,
    /// Replace the running manager, in place, with the binary now installed
    /// at its path: same pid, every task keeps running, clients reconnect.
    /// The daemon also does this by itself when that file changes.
    Upgrade,
    /// Tail manager.log, or a task's output when TASK_ID is given.
    /// With TASK_ID: follows the merged `.output` file (use --stderr for the
    /// stderr-only sibling). Without TASK_ID: tails manager.log.
    Log {
        /// Optional task id. When set, tails that task's output instead of manager.log.
        task_id: Option<String>,
        #[usage(short = 'f', long)]
        follow: bool,
        /// Number of trailing lines to print before following (or as the whole dump).
        #[usage(short = 'n', long, default = "100")]
        lines: usize,
        /// Tail the stderr-only file (`<task>.stderr`) instead of the merged output.
        /// Requires TASK_ID.
        #[usage(long)]
        stderr: bool,
    },
    /// Follow a task's output in real time (shortcut for `log -f TASK_ID`).
    /// `-f` is accepted for muscle memory (`tail -f ID`) and is always on.
    Tail {
        task_id: String,
        /// Accepted and ignored (follow is always on for `tail`).
        #[usage(short = 'f', long)]
        follow: bool,
        #[usage(short = 'n', long, default = "100")]
        lines: usize,
        /// Tail stderr only (`<task>.stderr`).
        #[usage(long)]
        stderr: bool,
    },
    /// Start a task (convenience for scripting/smoke tests; owns the task via
    /// an extension-style session binding).
    Start {
        /// Session that owns the task.
        #[usage(long, default = "cli")]
        session: String,
        /// Task kind: shell | monitor.
        #[usage(long, default = "shell")]
        kind: String,
        #[usage(long)]
        cwd: Option<String>,
        /// Hard kill ceiling in ms (omit for no limit).
        #[usage(long)]
        timeout_ms: Option<u64>,
        /// Semantic marker only (§3.3); manager behaviour is unchanged.
        #[usage(long)]
        background: bool,
        /// Shell command string (run via `sh -c`).
        #[usage(double_dash = "automatic")]
        command: String,
    },
    /// Budget-wait on a task's exit.
    Wait {
        task_id: String,
        #[usage(long, default = "20000")]
        budget_ms: u64,
    },
    /// Print a shell completion script.
    Completion {
        /// Which shell to generate for.
        #[usage(long, choices("bash", "zsh", "fish"))]
        shell: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{Cli, Sub};
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn global_options_and_visible_alias_parse_with_usage() {
        let argv = ["--home", "/tmp/pbs", "ls", "-a", "--json"].map(OsStr::new);
        let cli = Cli::parse_from(&argv).expect("valid list invocation");

        assert_eq!(cli.home.as_deref(), Some(Path::new("/tmp/pbs")));
        assert!(matches!(
            cli.cmd,
            Sub::List {
                all: true,
                json: true,
                ..
            }
        ));
    }

    #[test]
    fn tail_accepts_dash_f_and_wait_keeps_its_budget_default() {
        // `tail -f` is muscle memory from `tail -f ID`: the flag must parse
        // even though tail always follows.
        let cli = Cli::parse_from(&[OsStr::new("tail"), OsStr::new("-f"), OsStr::new("task_1")])
            .expect("valid tail invocation");
        let Sub::Tail {
            task_id,
            lines,
            stderr,
            ..
        } = cli.cmd
        else {
            panic!("tail should be selected");
        };
        assert_eq!(task_id, "task_1");
        assert_eq!(lines, 100);
        assert!(!stderr);

        let cli = Cli::parse_from(&[OsStr::new("wait"), OsStr::new("task_1")])
            .expect("valid wait invocation");
        let Sub::Wait { budget_ms, .. } = cli.cmd else {
            panic!("wait should be selected");
        };
        assert_eq!(budget_ms, 20000);
    }

    #[test]
    fn start_keeps_its_single_shell_command_and_defaults() {
        let argv = ["start", "--", "-nasty command"].map(OsStr::new);
        let cli = Cli::parse_from(&argv).expect("valid start invocation");

        let Sub::Start {
            session,
            kind,
            command,
            ..
        } = cli.cmd
        else {
            panic!("start should be selected");
        };
        assert_eq!(session, "cli");
        assert_eq!(kind, "shell");
        assert_eq!(command, "-nasty command");
    }
}
