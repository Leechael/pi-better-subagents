# pbs-manager CLI

Standalone operations manual for the `pbs-manager` binary.

The pi extension talks to the daemon over a socket. These subcommands are the human and scripting surface for inspection, debugging, and smoke tests. Human-readable table output is **not** a wire contract.

## Install

```bash
cd manager && cargo build --release
mkdir -p ~/.pi/agent/pbs/bin
cp target/release/pbs-manager ~/.pi/agent/pbs/bin/
export PATH="$HOME/.pi/agent/pbs/bin:$PATH"
```

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
manager.lock
manager.log
sessions/<session_id>/tasks/<task_id>.{json,output,stderr}
```

## Quick reference

```bash
pbs-manager daemon [--foreground]
pbs-manager status
pbs-manager sessions
pbs-manager list [--session <id>] [-a|--all]
pbs-manager ls …                      # alias of list
pbs-manager start [--session cli] [--kind shell|monitor] [--cwd DIR] [--timeout-ms N] [--background] '<cmd>'
pbs-manager wait <task_id> [--budget-ms 20000]
pbs-manager output <task_id> [-f] [--max-bytes 65536]
pbs-manager log [-f] [-n 100] [TASK_ID] [--stderr]
pbs-manager tail [-f] <TASK_ID> [-n 100] [--stderr]
pbs-manager stop <task_id>
pbs-manager kill-session <session_id>
pbs-manager doctor
pbs-manager shutdown
```

Except `daemon`, every subcommand is a client. Most open a short-lived socket connection (hello → request → exit). If no daemon is running, the client claims the spawn lock and starts one. `doctor` is mostly offline filesystem checks (it may also probe the socket).

---

## Subcommands

### `daemon`

Run the manager in the foreground (what auto-spawn uses).

```bash
pbs-manager daemon
pbs-manager daemon --foreground   # also mirror logs to stderr
```

You normally do **not** start this by hand; `status` / `list` / the extension spawn it when needed. One singleton per `--home`.

### `status`

Print version, pid, uptime, session summary, and running/terminal task counts.

```bash
pbs-manager status
```

### `sessions`

Table of connected pi sessions: `SESSION_ID`, `PI_PID`, connected flag.

```bash
pbs-manager sessions
```

### `list` / `ls`

List tasks. Alias: `ls`. As a CLI client you are admin: with no `--session`, you see every session. **Default: running tasks only.**

```bash
pbs-manager list
pbs-manager ls
pbs-manager list --session <sid>
pbs-manager list -a                 # include exited / terminal tasks
pbs-manager ls --all
```

Columns: `TASK_ID SESSION STATUS PID EXIT SIZE COMMAND`.

- `COMMAND` is the **first line only**, then truncated (~60 chars).
- `EXIT` is an exit code, `sigN`, or `-` while running.

### `start`

Convenience spawn for scripting / smoke tests. Binds the task to an extension-style session (default `cli`).

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
| `--timeout-ms` | none | Hard kill ceiling |
| `--background` | off | Semantic marker only; manager behavior is unchanged |
| `<COMMAND>` | required | Run via `sh -c` |

On success prints:

```text
task_id=sh_… pid=12345
```

### `wait`

Budget-wait for a task to leave the running state (protocol `wait`).

```bash
pbs-manager wait sh_a1b2c3d4
pbs-manager wait sh_a1b2c3d4 --budget-ms 5000
```

| Outcome | Printed line |
|---|---|
| Exited | `done exit_code=N` or `done exit_code=null` |
| Budget expired | `not done (budget expired; task still running)` |

The process exit code of the CLI is still `0` in both cases unless the request itself fails. The task keeps running after budget expiry.

Requires an exact `task_id` (no fuzzy resolve).

### `output`

Read task output through the **protocol** (64KB ring + disk cursor), not by opening the file directly.

```bash
pbs-manager output sh_a1b2c3d4
pbs-manager output sh_a1b2c3d4 -f              # follow until terminal and caught up
pbs-manager output sh_a1b2c3d4 --max-bytes 4096
```

Use this when you want the same byte stream the extension sees. Prefer `log` / `tail` for everyday file following. Requires an exact `task_id`.

### `log`

Tail **manager.log**, or a task’s on-disk output when `TASK_ID` is given.

```bash
pbs-manager log                    # last 100 lines of manager.log
pbs-manager log -f                 # follow manager.log
pbs-manager log -n 50
pbs-manager log sh_a1b2c3d4        # dump last 100 lines of merged .output
pbs-manager log -f sh_a1b2c3d4     # follow merged stdout+stderr
pbs-manager log -f sh_a1b2c3d4 --stderr   # follow <id>.stderr only
```

| Flag | Meaning |
|---|---|
| `-f` / `--follow` | Keep reading new bytes |
| `-n` / `--lines` | Trailing lines before follow (default 100) |
| `--stderr` | Use `<task>.stderr` instead of merged `.output` (requires `TASK_ID`) |

Task ids for `log` / `tail` are **fuzzy-resolved** (see below).

### `tail`

Always-follow shortcut for `log -f <TASK_ID>`.

```bash
pbs-manager tail sh_a1b2c3d4
pbs-manager tail -f sh_a1b2c3d4 --stderr   # -f accepted, ignored (always on)
pbs-manager tail sh_a1b2c3d4 -n 20
```

### `stop`

Stop one task: SIGTERM to the process group → 2s → SIGKILL.

```bash
pbs-manager stop sh_a1b2c3d4
```

Requires an exact `task_id`. Prints `stopped <id>`.

### `kill-session`

Stop every **running** task owned by a session (list + stop; no extra wire op).

```bash
pbs-manager kill-session <session_id>
```

### `doctor`

Filesystem consistency check: prints home / socket / pid / lock paths. If the pid file points at a dead process, removes stale pid/socket files. If the process is alive, probes the socket with a hello.

```bash
pbs-manager doctor
```

### `shutdown`

Ask the daemon to shut down gracefully (kills remaining tasks).

```bash
pbs-manager shutdown
```

Prints `manager shutting down`. After ~5s with zero connections the daemon also self-exits; `shutdown` is the explicit path.

---

## Task id resolution (`log` / `tail` only)

When `log` or `tail` takes a `TASK_ID`, the typed string is resolved against the current task list:

1. Exact id (`mon_e1351cb1`)
2. Unique prefix / suffix / substring (`e1351cb1`, `mon_e135`)
3. Unique near-miss (edit distance ≤ 2), e.g. typo `cmon_…` → `mon_…`

Ambiguous matches error with the candidate list. Unknown ids suggest the closest known id when possible. A successful fuzzy match prints `note: resolved '…' → '…'` on stderr.

`stop`, `wait`, and `output` require the exact id.

## `log` / `tail` vs `output`

| | `log` / `tail` | `output` |
|---|---|---|
| Source | On-disk `.output` / `.stderr` | Protocol cursor (ring + file) |
| Best for | Watching a build by hand | Scripts matching extension semantics |
| Follow | File poll (~200ms) | Request loop until terminal |
| Fuzzy ids | Yes | No |

Merged stream = stdout + stderr tee’d into `<id>.output`. stderr is also mirrored to `<id>.stderr` for `--stderr`.

## Typical workflows

```bash
# Is the daemon up? What’s running?
pbs-manager status
pbs-manager list

# Smoke-start and watch
line=$(pbs-manager start 'for i in 1 2 3; do echo $i; sleep 1; done')
id=${line#task_id=}; id=${id%% *}
pbs-manager tail "$id"

# Debug a stuck monitor (fuzzy id ok for log/tail)
pbs-manager list
pbs-manager log -f e1351cb1 --stderr

# Tear down
pbs-manager stop sh_a1b2c3d4
pbs-manager kill-session cli
pbs-manager shutdown
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Request succeeded (including `wait` budget expiry and `doctor` reports) |
| `1` | Error message on stderr (`pbs-manager: …`) |

## Lifecycle notes

- Machine-wide singleton per home directory.
- After ~5 seconds with zero connections, the daemon kills remaining tasks and exits.
- On next client connect it may restart and re-adopt still-living PIDs (output continues from the on-disk files; exit code may be unavailable → terminal `completed` with `exit_code: null`).
