# pbs-manager CLI

Standalone operations manual for the `pbs-manager` binary.

The pi extension talks to the daemon over a socket. These subcommands are the human and scripting surface for inspection, debugging, and smoke tests. Human-readable tables are **not** a wire contract; use `--json` (on `status`, `sessions`, `ls`, `show`, `events`) for scripts.

From the CLI alone you can answer: what is each session doing and where (cwd), what is running or just finished, why did it end, what did this subagent do, why didn't a notification arrive, and is the system healthy.

## Install

```bash
cd manager && cargo build --release
mkdir -p ~/.pi/agent/pbs/bin
# Use `install` (or cp→mv) so the path gets a new inode. Overwriting the
# existing file in place invalidates macOS's code-signing cache and the next
# exec is SIGKILL'd (`killed`, exit 137) even when `codesign -vv` still says valid.
install -m 755 target/release/pbs-manager ~/.pi/agent/pbs/bin/pbs-manager
export PATH="$HOME/.pi/agent/pbs/bin:$PATH"
```

If you already hit `killed` after a reinstall, fix with another atomic replace (same `install` line above), or `cp …/pbs-manager …/pbs-manager.new && mv …/pbs-manager.new …/pbs-manager`.

**Upgrading while pi sessions run work:** just `install` the new binary. A running daemon notices within a few seconds and upgrades itself in place (see [`upgrade`](#upgrade)); `pbs-manager upgrade` does it now and reports the result. Nothing running is interrupted and no pi session needs a restart; reload or reopen pi sessions only when you also want the new extension code.

The extension discovers the same path, or an override via `PBS_MANAGER_PATH` / `managerPath` in config.

## Global options

| Flag / env | Meaning |
|---|---|
| `--home <dir>` | State directory for this invocation |
| `PBS_HOME` | Same, if `--home` is omitted |
| (default) | `~/.pi/agent/pbs` |

Priority: `--home` > `PBS_HOME` > default.

Layout under home:

```
manager.sock
manager.pid
manager.lock           # held by the running daemon for its whole lifetime
manager.spawn.lock     # held by a client while it spawns the daemon
manager.log
events.jsonl           # daemon.start / daemon.shutdown
config.json            # optional
sessions/<session_id>/events.jsonl
sessions/<session_id>/tasks/<task_id>.{json,output,stderr}
sessions/<session_id>/agents/<child_id>.{json,jsonl}   # written by the extension
```

## Quick reference

```bash
pbs-manager status [--json]
pbs-manager sessions [--json]
pbs-manager ls [--session PREFIX] [--cwd DIR] [--since DUR] [--json]   # alias of list
pbs-manager show <id> [--json]
pbs-manager agent <ch_id> [--full] [-f]
pbs-manager events [-f] [--session PREFIX] [--id ID] [--since DUR] [--json]
pbs-manager log [-f] [-n 100] [ID] [--stderr]
pbs-manager tail <ID> [-n 100] [--stderr]
pbs-manager output <id> [-f] [--max-bytes N]
pbs-manager wait <id> [--budget-ms 20000]
pbs-manager stop <id>
pbs-manager kill-session <session_id>
pbs-manager start [--session cli] [--kind shell|monitor] [--cwd DIR] [--timeout-ms N] [--background] '<cmd>'
pbs-manager doctor
pbs-manager shutdown
pbs-manager daemon [--foreground]
```

Ids: `sh_…` shell, `mon_…` monitor, `ch_…` agent (subagent child), `run_…` subagent run. Every command that takes an id accepts it **fuzzily**: exact, a unique prefix/suffix/substring (`e1351cb1`, `mon_e135`), or a unique near-miss within edit distance 2 (`cmon_…` → `mon_…`); a fuzzy match prints `note: resolved '…' → '…'` on stderr. Ambiguous input lists up to five candidates. An unknown id prints one line with the closest known id: `unknown id 'x' (did you mean 'y'?)`.

Durations (`--since`): `500ms`, `30s`, `10m`, `2h`, `1d` (a bare number is seconds).

### Which commands start the daemon

| Starts the daemon when none runs | Never starts it |
|---|---|
| `ls`, `output`, `wait`, `stop`, `kill-session`, `start` | `status` (prints "pbs-manager is not running", exit 1), `sessions` and `show` (read the disk instead), `agent`, `events`, `log`, `tail`, `doctor`, `shutdown` (prints "pbs-manager is not running", exit 0) |

A daemon started this way exits again ~5s after its last client leaves (§3.2).

Output is pipe-friendly: when the reader goes away (`… | head`), the CLI exits quietly with status 0.

---

## Inspection

### `status`

```text
version:  0.1.0+066598ae00 (protocol 3)
pid:      4321
binary:   /Users/me/.pi/agent/pbs/bin/pbs-manager
uptime:   13m23s
sessions: 2 (1 connected)
tasks:    3 running, 8 finished (shells 2/5, agents 1/3)
```

The version carries the commit the binary was built from, so two builds of 0.1.0 differ; `unknown` for a build outside a git checkout. `binary` is the daemon's file, the one an [`upgrade`](#upgrade) execs, which is not necessarily the CLI you ran. Counts include agents (running/finished shells and agents are also shown separately). `--json` prints the protocol `status` response plus `agent_counts`. With no daemon: `pbs-manager is not running` on stderr, exit 1.

### `sessions`

```text
SESSION   PI_PID STATE     CWD         SINCE    LAST_SEEN RUNNING TASKS AGENTS
0199aaaa  81234  connected ~/src/app   14:02:11 now       2       7     1
```

Connected sessions only (a gone session is listed while it still runs something). When a pi session exits, it leaves the listings at once; its files stay on disk for `goneSessionRetention` (see below) so `agent` and `events --session` still reach it, and are then deleted. A finished task's own record and output reach `show` for only `finishedTaskRetention` (see below), which can be shorter. `SESSION` is the shortest unique prefix, at least 8 characters. `RUNNING` counts running tasks and agents; a record that says an agent is running while its session is gone is not counted (it cannot be alive).

### `ls` / `list`

```text
ID           KIND    SESSION   CWD        STATUS    STARTED  DUR    EXIT    REASON       TITLE
sh_3f2a91c0  shell   0199aaaa  ~/src/app  running   14:03:22 1m04s  -       -            npm test
mon_e1351cb1 monitor 0199aaaa  ~/src/app  killed    14:01:10 30s    SIGTERM stopped:tui  tail -f log
ch_7d0e22a1  agent   0199aaaa  ~/src/app  failed    14:00:05 12s    -       model-error  broken (worker) m1
```

Work of connected sessions, running and finished, plus anything still running in a gone session (a live process is never hidden). There is no `--all`: a gone session's finished work is reached by id (`show`) until its session's retention or the finished-task retention ends, whichever comes first. Filters: `--session PREFIX` (session id prefix), `--cwd DIR` (that directory or below; agents use their session's cwd), `--since DUR` (started within). `--json` prints an array of row objects (`id`, `kind`, `session_id`, `cwd`, `status`, `started_at`, `ended_at`, `duration_ms`, `exit_code`, `signal`, `end_reason`, `title`, plus `pid`/`origin`/`backgrounded_at`/`run_id`/`error` when known).

- `EXIT` is the exit code, a signal name (`SIGTERM`, `SIGKILL`, …), or `-`.
- `REASON` is the task's `end_reason` (see below), or an agent record's `end_reason`.
- `TITLE` is the command's first line (agents: `name (agent) model`), truncated by **display width** so CJK and emoji keep the table aligned: to the terminal width on a tty, to 60 columns otherwise.

`end_reason` values: `exited` (the process exited on its own, any code) · `timeout` (`timeout_ms` ceiling or a stop with reason timeout) · `stopped:tui` / `stopped:cli` / `stopped:tool` (a stop request, by who) · `rate-limit` · `session-end` · `manager-shutdown` · `manager-crash` (the manager died without shutting down, e.g. `kill -9`; its task was taken down with it, and the next daemon marked the record `orphaned`).

### `show`

Everything about one id, any kind:

- **task / monitor:** status, exit, reason, session (state, pi pid), full command, cwd, pid, start/end/duration, when it was moved to the background, who spawned it (`origin`: `bash-fg`, `bash-bg`, `child-bash` with child and run, `monitor`), output and stderr paths, wake notification emitted → delivered (from the extension's events), and the last 10 output lines.
- **agent (`ch_…`):** name/agent/model, run, status and end reason, error, start/end/duration, tool-call count, shells it spawned (tasks whose `origin.child_id` is this agent), transcript path, the task prompt, and the last 20 lines of its result.
- **run (`run_…`):** its children as an `ls` table.

`--json` prints the underlying records, the output tail, and the related events.

### `agent`

```bash
pbs-manager agent ch_7d0e22a1          # conversation, preamble hidden
pbs-manager agent ch_7d0e22a1 --full   # include system prompt / agent preamble
pbs-manager agent ch_7d0e22a1 -f       # keep following
```

Renders the transcript `sessions/<sid>/agents/<ch>.jsonl` (one JSON object per message: `role`, `text`, `tool`, `args`, `isError`, `ts`). Without `--full`, `system` messages and lines marked `"preamble":true` are hidden, and the first user message is shown as the task prompt (`prompt_head` from the agent record).

### `events`

```text
2026-09-23 14:03:22.123 0199aaaa manager   task.exit          sh_3f2a91c0 exit_code=0 end_reason=exited duration_ms=64012
2026-09-23 14:03:22.140 0199aaaa extension wake.emit          - kind=task ids=["sh_3f2a91c0"] batch=1
```

The event log, merged and time-ordered across every session (plus daemon events). Filters: `--session PREFIX`, `--id ID` (matches `id`, `child_id`, or an entry of `ids`), `--since DUR`. `--json` prints one raw event per line with a `session` field added. `-f` follows all files, including sessions that appear later. Malformed lines are skipped, with a count on stderr.

What is logged: see design §3.3 "Event log". The manager writes `session.connect/disconnect`, `task.start/background/stop/exit`, `daemon.start/shutdown`; the extension writes wake, monitor, agent and decision events.

### `log` / `tail`

```bash
pbs-manager log                    # last 100 lines of manager.log, local timestamps
pbs-manager log -f
pbs-manager log sh_a1b2c3d4        # task's merged stdout+stderr
pbs-manager log -f sh_a1b2c3d4 --stderr
pbs-manager log ch_7d0e22a1        # agent: rendered transcript
pbs-manager tail sh_a1b2c3d4       # = log -f; -f is accepted and ignored
```

| Flag | Meaning |
|---|---|
| `-f` / `--follow` | Keep reading new bytes (`tail` always follows) |
| `-n` / `--lines` | Trailing lines before follow (default 100) |
| `--stderr` | `<task>.stderr` instead of the merged `.output` (tasks only) |

`log`/`tail` read files directly (polling ~200ms); `output` goes through the protocol:

| | `log` / `tail` | `output` |
|---|---|---|
| Source | On-disk `.output` / `.stderr`, agent transcript | Protocol cursor (ring + file), agent result |
| Best for | Watching by hand | Scripts matching extension semantics |
| Starts the daemon | No | Yes |

### `doctor`

Health checks, one line each (`ok`, `fixed`, `warn`, `FAIL`), then `ok` or `N problem(s) found`. **Exit status 1 when any check fails.**

- home exists (doctor never creates it)
- socket path length fits a unix socket (103 bytes on macOS, 107 on Linux)
- `config.json` parses; the manager path from `PBS_MANAGER_PATH` or `managerPath` exists
- daemon: running exactly when it holds `manager.lock` (the recorded pid is not trusted; it may belong to another process after a crash). Running → probe the socket. Not running → take the lock and remove stale socket/pid files (`fixed`, not a failure)
- protocol: every connected session announced the manager's protocol
- stale agent records: an agent says running but its session is gone
- orphan pids: a task still running with no manager to own it
- session retention: `goneSessionRetention` in `config.json` is a valid duration
- task retention: `finishedTaskRetention` in `config.json` is a valid duration
- sessions dir size (warn above 100 MiB; events.jsonl has no rotation yet)

---

## Acting on tasks

### `output`

```bash
pbs-manager output sh_a1b2c3d4
pbs-manager output sh_a1b2c3d4 -f              # follow until finished and caught up
pbs-manager output sh_a1b2c3d4 --max-bytes 4096
```

The same byte stream the extension sees (§3.3 cursor reads; chunks never split a UTF-8 character). `--max-bytes N` prints **at most N bytes in total**; a character that would cross the limit is left out. For an agent id, prints the agent's result.

### `wait`

```bash
pbs-manager wait sh_a1b2c3d4 --budget-ms 5000
```

| Outcome | Printed line |
|---|---|
| Exited | `done exit_code=N` / `done exit_code=null` |
| Budget expired | `not done (budget expired; task still running)` |
| Agent finished | `done status=completed` |

Exit status 0 in every case unless the request fails. The task keeps running after the budget expires.

### `stop`

Stop one task: SIGTERM to its process group → 2s → SIGKILL (§3.3), recorded as `stopped:cli`. Prints `stopped <id>`, or `<id> already finished (<reason>)` for a task that had already ended (leftover background children of a finished task are still cleaned up). For an agent id: `agents run inside pi; stop from /tasks or ask the agent` (exit 1): the CLI cannot reach in-process children.

### `kill-session`

Stops every running task of a session (list + stop, reason `cli`).

### `start`

Convenience spawn for scripting and smoke tests. Binds the task to an extension-style session (default `cli`).

```bash
pbs-manager start 'echo hello'
pbs-manager start --session my-sess --cwd /tmp --timeout-ms 60000 'sleep 5 && echo done'
pbs-manager start --kind monitor --background 'while true; do date; sleep 1; done'
```

| Flag | Default | Notes |
|---|---|---|
| `--session` | `cli` | Owning session id |
| `--kind` | `shell` | `shell` or `monitor` |
| `--cwd` | process cwd | Working directory |
| `--timeout-ms` | none | Hard kill ceiling (`end_reason: timeout`) |
| `--background` | off | Semantic marker only |
| `<COMMAND>` | required | Run via `sh -c` |

Prints `task_id=sh_… pid=12345`.

---

## Daemon

### `daemon`

Runs the manager in the foreground (what auto-spawn uses); `--foreground` also logs to stderr. One daemon per home: the daemon holds `manager.lock` for its lifetime; a second one prints "already running" and exits 0.

### `upgrade`

Replaces the running daemon, in place, with the binary now installed at its path: same pid, every task keeps running (and later reports its real exit code), clients reconnect by themselves within tens of milliseconds. Requests in flight during the switch are resent by the clients; a `start` is never run twice.

```text
upgraded in place: 0.1.0 -> 0.1.1 (pid 4321, generation 1, 3 running task(s) kept)
```

- The daemon execs the file at **its own path** (`binary:` in `status`), not the CLI you run. Running `upgrade` from another file (say a fresh `target/release`) prints a note saying so; install the build to that path first.
- The new binary is checked first (`__handover-check`). A missing, broken or incompatible binary stops the upgrade before anything is touched: `upgrade not done, still running 0.1.0: …` (exit 1).
- If the switch itself cannot finish (quiesce over 5s, exec failure), the daemon keeps running the old binary and says why.
- If the new binary cannot restore, it exits and every task is cleaned up, as in a crash (no crash recovery); `upgrade` reports `the manager (pid N) exited during the upgrade`.
- With no daemon running: `pbs-manager is not running; the next client starts the installed binary` (exit 0).
- The daemon does the same by itself when the file at its path changes and settles (checked every 2s). `status` then shows `upgrades: 2 (last: 0.1.0 -> 0.1.1, binary-changed, 3m ago)`, or `upgrades: 1 (last attempt failed 2m ago, cli: …)`; nothing while there has been no upgrade. `status --json` has `generation` and `last_upgrade` (`trigger: "cli"` or `"binary-changed"`).

### `shutdown`

Asks the daemon to shut down gracefully: every running task and every leftover process group of a finished task gets SIGTERM, then SIGKILL after 2s; records end as `manager-shutdown`. Prints `manager shutting down`. The daemon also shuts itself down ~5s after its last client disconnects.

The manager is the parent of every task and there is no crash recovery. Each task runs under a small runner (`pbs-manager __run`) that holds a lifeline to the daemon. If the daemon dies without shutting down (`kill -9`, a panic), every runner sees the lifeline break and takes its process group down: SIGTERM, then SIGKILL after 2s, background children included. The next daemon re-adopts nothing and signals nothing: only records still persisted as `running` are marked `orphaned` with `end_reason: manager-crash`; a command that already exited (even if its guardian runner is still cleaning up leftover children) has a terminal record that stays unchanged.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, including `wait` budget expiry, `stop` on a finished task, `shutdown` with no daemon, and a reader closing the pipe |
| `1` | Error (`pbs-manager: …` on stderr), `status` with no daemon, a `doctor` check failed |

## Retention of gone sessions

A session is *gone* once its pi process disconnects. Gone sessions leave `ls` and `sessions` immediately. Their directory `sessions/<sid>/` (task records and output, agent records and transcripts, `events.jsonl`) is kept for `goneSessionRetention` after its last write, then the daemon deletes it and forgets its tasks. The daemon sweeps at startup and every `min(retention, 1h)` (at least every second). A session that is connected, or still owns a running task or a live process group, is never swept.

```json
{ "goneSessionRetention": "24h" }
```

in `<home>/config.json`; any duration (`30m`, `7d`, `0s` = at the next sweep). Default `24h`. An invalid value makes `doctor` fail and the daemon use the default.

## Retention of finished tasks

A connected session is never swept, so a pi session left open for days would keep every command's record and output, and the daemon loads all of them at startup. Independently of the session, a finished task's files (`<id>.json`, `.output`, `.stderr`) are deleted `finishedTaskRetention` after it ended, in every session, and the task leaves `ls` and `show`. A task whose process group still has members is kept until it empties. Agent records and transcripts and `events.jsonl` are not touched by this rule (only by the session retention above).

```json
{ "finishedTaskRetention": "24h" }
```

Same duration format, default and `doctor` check as `goneSessionRetention`. The sweep runs with the session sweep, at the shorter of the two cadences.

## Typical workflows

```bash
# What is running, where, and why did the last thing stop?
pbs-manager ls
pbs-manager ls --since 10m
pbs-manager show e1351cb1

# What did a subagent do?
pbs-manager ls | grep agent
pbs-manager show ch_7d0e22a1
pbs-manager agent ch_7d0e22a1

# Why didn't a notification arrive?
pbs-manager events --id sh_3f2a91c0

# Smoke-start and watch
line=$(pbs-manager start 'for i in 1 2 3; do echo $i; sleep 1; done')
id=${line#task_id=}; id=${id%% *}
pbs-manager tail "$id"

# Health
pbs-manager doctor
```
