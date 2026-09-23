//! pbs-manager — process management daemon for pi-better-subagents.
//! Single binary: `daemon` runs the manager; every other subcommand is a
//! socket client (design doc §3.5).

mod out;

mod client;
mod clock;
mod daemon;
mod events;
mod fmt;
mod inspect;
mod lifecycle;
mod proto;
mod registry;
mod sys;
mod task;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "pbs-manager",
    version,
    about = "Process management daemon for pi-better-subagents"
)]
struct Cli {
    /// Base directory. Priority: --home flag > PBS_HOME env > ~/.pi/agent/pbs (§3.1).
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Sub,
}

#[derive(Subcommand)]
enum Sub {
    /// Run the manager daemon in the foreground (this is what clients spawn).
    Daemon {
        /// Also log to stderr (for debugging).
        #[arg(long)]
        foreground: bool,
    },
    /// Version, protocol, uptime, sessions, task and agent counts. Never
    /// starts the daemon ("pbs-manager is not running", exit 1).
    Status {
        #[arg(long)]
        json: bool,
    },
    /// pi sessions: connected ones, or with -a also past (gone) sessions.
    Sessions {
        /// Include sessions that are no longer connected (from disk).
        #[arg(short = 'a', long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// List tasks and agents (running only by default). Alias: `ls`.
    #[command(visible_alias = "ls")]
    List {
        /// Only sessions whose id starts with this prefix.
        #[arg(long)]
        session: Option<String>,
        /// Only work whose cwd is this directory or below it.
        #[arg(long)]
        cwd: Option<String>,
        /// Only work started within this long (e.g. 30s, 10m, 2h, 1d).
        #[arg(long)]
        since: Option<String>,
        /// Include finished tasks and agents (default: running only).
        #[arg(short = 'a', long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Everything about one task, monitor, agent (ch_…) or run (run_…).
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Render an agent's transcript (preamble hidden unless --full).
    Agent {
        id: String,
        /// Include the system prompt / agent preamble.
        #[arg(long)]
        full: bool,
        /// Keep following the transcript.
        #[arg(short = 'f', long)]
        follow: bool,
    },
    /// Event log, merged and time-ordered across sessions.
    Events {
        #[arg(short = 'f', long)]
        follow: bool,
        /// Only sessions whose id starts with this prefix.
        #[arg(long)]
        session: Option<String>,
        /// Only events about this task/agent id.
        #[arg(long)]
        id: Option<String>,
        /// Only events within this long (e.g. 30s, 10m, 2h).
        #[arg(long)]
        since: Option<String>,
        /// One raw JSON object per line.
        #[arg(long)]
        json: bool,
    },
    /// Read a task's output through the protocol; -f follows. For an agent
    /// id, prints its result.
    Output {
        task_id: String,
        /// Follow the output stream.
        #[arg(short = 'f', long)]
        follow: bool,
        /// Print at most this many bytes in total.
        #[arg(long)]
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
    /// Tail manager.log, or a task's output when TASK_ID is given.
    /// With TASK_ID: follows the merged `.output` file (use --stderr for the
    /// stderr-only sibling). Without TASK_ID: tails manager.log.
    Log {
        /// Optional task id. When set, tails that task's output instead of manager.log.
        task_id: Option<String>,
        #[arg(short = 'f', long)]
        follow: bool,
        /// Number of trailing lines to print before following (or as the whole dump).
        #[arg(short = 'n', long, default_value_t = 100)]
        lines: usize,
        /// Tail the stderr-only file (`<task>.stderr`) instead of the merged output.
        /// Requires TASK_ID.
        #[arg(long)]
        stderr: bool,
    },
    /// Follow a task's output in real time (shortcut for `log -f TASK_ID`).
    /// `-f` is accepted for muscle memory (`tail -f ID`) and is always on.
    Tail {
        task_id: String,
        /// Accepted and ignored (follow is always on for `tail`).
        #[arg(short = 'f', long, action = clap::ArgAction::SetTrue)]
        follow: bool,
        #[arg(short = 'n', long, default_value_t = 100)]
        lines: usize,
        /// Tail stderr only (`<task>.stderr`).
        #[arg(long)]
        stderr: bool,
    },
    /// Start a task (convenience for scripting/smoke tests; owns the task via
    /// an extension-style session binding).
    Start {
        /// Session that owns the task.
        #[arg(long, default_value = "cli")]
        session: String,
        /// Task kind: shell | monitor.
        #[arg(long, default_value = "shell")]
        kind: String,
        #[arg(long)]
        cwd: Option<String>,
        /// Hard kill ceiling in ms (omit for no limit).
        #[arg(long)]
        timeout_ms: Option<u64>,
        /// Semantic marker only (§3.3); manager behaviour is unchanged.
        #[arg(long)]
        background: bool,
        /// Shell command string (run via `sh -c`).
        command: String,
    },
    /// Budget-wait on a task's exit.
    Wait {
        task_id: String,
        #[arg(long, default_value_t = 20000)]
        budget_ms: u64,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let home = lifecycle::resolve_home(cli.home.as_deref());
    let code = match cli.cmd {
        Sub::Daemon { foreground } => daemon::run(home, foreground).await,
        Sub::Status { json } => run_client(inspect::cmd_status(&home, json)).await,
        Sub::Sessions { all, json } => run_client(inspect::cmd_sessions(&home, all, json)).await,
        Sub::List {
            session,
            cwd,
            since,
            all,
            json,
        } => {
            let opts = inspect::LsOpts {
                all,
                session,
                cwd,
                since,
                json,
            };
            run_client(inspect::cmd_ls(&home, opts)).await
        }
        Sub::Show { id, json } => run_client(inspect::cmd_show(&home, &id, json)).await,
        Sub::Agent { id, full, follow } => {
            run_client(inspect::cmd_agent(&home, &id, full, follow)).await
        }
        Sub::Events {
            follow,
            session,
            id,
            since,
            json,
        } => {
            let opts = inspect::EventsOpts {
                follow,
                session,
                id,
                since,
                json,
            };
            run_client(inspect::cmd_events(&home, opts)).await
        }
        Sub::Output {
            task_id,
            follow,
            max_bytes,
        } => run_client(client::cmd_output(&home, &task_id, follow, max_bytes)).await,
        Sub::Stop { task_id } => run_client(client::cmd_stop(&home, &task_id)).await,
        Sub::KillSession { session_id } => {
            run_client(client::cmd_kill_session(&home, &session_id)).await
        }
        Sub::Doctor => client::cmd_doctor(&home).await,
        Sub::Shutdown => run_client(client::cmd_shutdown(&home)).await,
        Sub::Log {
            task_id,
            follow,
            lines,
            stderr,
        } => run_client(client::cmd_log(&home, follow, lines, task_id.as_deref(), stderr)).await,
        Sub::Tail {
            task_id,
            follow: _,
            lines,
            stderr,
        } => run_client(client::cmd_log(&home, true, lines, Some(task_id.as_str()), stderr)).await,
        Sub::Start {
            session,
            kind,
            cwd,
            timeout_ms,
            background,
            command,
        } => {
            run_client(
                client::cmd_start(&home, &session, &kind, cwd, timeout_ms, background, &command),
            )
            .await
        }
        Sub::Wait { task_id, budget_ms } => {
            run_client(client::cmd_wait(&home, &task_id, budget_ms)).await
        }
    };
    std::process::exit(code);
}

async fn run_client(f: impl std::future::Future<Output = Result<(), String>>) -> i32 {
    match f.await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("pbs-manager: {e}");
            1
        }
    }
}
