# pi-better-subagents

A pi extension for subagent orchestration, auto-backgrounding bash, monitoring tasks, and agent-to-agent communication. Process management lives in a standalone Rust daemon, `pbs-manager` (machine-wide singleton, session-isolated, exits with the last pi).

## Architecture

```
pi extension (extension/, TypeScript)        pbs-manager (manager/, Rust)
├─ bash override: foreground budget →        ├─ spawn/wait/stop/output engine
│  auto-background                           ├─ session_id namespacing
├─ subagent: parallel tasks / serial chain   ├─ output duality (ring + full log)
├─ monitor: command output → event stream    └─ lifecycle: 0 connections, 5s →
├─ agent_message / contact_supervisor           kill tasks and exit
└─ NotifyCenter: single injection point
   for all async events
```

Design doc (wire protocol, state machines, interface contracts): [docs/design.md](docs/design.md).

## Install

```bash
# 1. Build and install the manager (the extension auto-discovers it
#    at ~/.pi/agent/pbs/bin/)
cd manager && cargo build --release
mkdir -p ~/.pi/agent/pbs/bin
# Atomic replace (new inode). In-place `cp` onto an existing binary breaks
# macOS code-signing and the next run dies with SIGKILL / "killed".
install -m 755 target/release/pbs-manager ~/.pi/agent/pbs/bin/pbs-manager

# 2. Load the extension
pi -e /path/to/pi-better-subagents/extension   # local trial (recommended first)
# For keeps: publish to npm/git, then `pi install <source>`
```

**Conflict**: the legacy `pi-subagents` package also registers a `subagent` tool. Either `pi remove pi-subagents`, or test with `pi -ne -e ./extension` (note `-ne` suppresses your other extensions too).

**Degraded startup:** if `pbs-manager` is missing or cannot start, the extension warns in the TUI. Bash runs locally (so auto-backgrounding and manager-backed output/history are unavailable); `task_*` and `monitor` report that they are disabled. In-process subagents remain usable. Fix the manager installation or point to a binary with `PBS_MANAGER_PATH` / `managerPath` in config.json. If the extension is loaded outside pi and pi's bundled `pi-tui` cannot be resolved, a one-time console warning explains that interactive `/tasks` views use reduced text fallback; load the extension through pi for the full interactive UI.

## Tools

### bash (overrides the built-in)
Adds a `run_in_background` parameter. Foreground commands that exceed `foregroundBudgetMs` (default 20s) move to the background automatically; completion arrives as a `<pbs-wake kind="task">`. Bare `sleep` commands are rejected (use monitor or the background flag instead).

### subagent
```
subagent({ tasks: [{agent?, prompt, name?}], ... })   // parallel, ≤10, concurrency 1..8
subagent({ chain: [{agent?, prompt, label?}], ... })  // serial, {previous}/{outputs.<label>} interpolation
subagent({ action: "list|get|status|interrupt|resume|steer|models", run_id?, child_id?, message? })
```
- Synchronous wait up to 45s (`subagent.budgetMs`); on expiry the run continues in the background with a `run_id`, and completion arrives via `<pbs-wake kind="subagent-done">`. **Never poll.**
- `model` accepts fuzzy specs (`"haiku"`, `"openai/gpt-5.2"`, `"luna:high"`); the candidate set respects pi's whitelist (`enabledModels` / `--models`). Use `action:"models"` to list selectable values before choosing.
- Subagents run in-process via `createAgentSession`, capped at depth 1 (no nesting), with a no-background bash variant. The stall watchdog is 5 minutes of inactivity, paused while a tool is executing or a `need_decision` is pending. The hard child timeout is 30 minutes. A decision request waits 10 minutes.

### monitor
```
monitor({ command, description, timeout_ms?, persistent? })
```
Each output line becomes an event (200ms batching, 500 chars/line and 3000 chars/batch caps, 10 events per 2s rate limit). Exit, timeout, and rate-limit saturation all produce notifications.

### task_list / task_output / task_stop
Manage shell/monitor tasks held by the manager.

### agent_message (parent↔child comms)
```
agent_message({ action: "send|reply|broadcast|list", to?, message?, delivery?: "steer"|"queue" })
```
Children additionally get `contact_supervisor({ reason: "need_decision"|"progress_update", message })` — `need_decision` blocks the child until the parent replies (10-minute timeout, `decisionTimeoutMs`). `agent_message` send to a finished child **errors** and tells you to resume with `subagent({ action: "resume", run_id, child_id, message })`. It does not resume the child.

## Agent definitions

Markdown with frontmatter, three tiers (later wins): built-in (`explorer`/`worker`) → `~/.pi/agent/agents/**/*.md` → `<project>/.pi/agents/**/*.md`:

```markdown
---
name: reviewer
description: Code review specialist
tools: [read, bash, grep]
model: anthropic:claude-haiku-4-5   # fuzzy ok; falls back to parent model if unresolvable
thinking: high
---
You are a reviewer… (body = system prompt segment)
```

## Configuration `~/.pi/agent/pbs/config.json`

```json
{
  "foregroundBudgetMs": 20000,
  "managerPath": null,
  "logLevel": "info",
  "subagent": { "budgetMs": 45000, "timeoutMs": 1800000, "stallMs": 300000,
                "decisionTimeoutMs": 600000,
                "concurrency": 4, "maxConcurrentChildren": 8, "spawnBudgetPerHour": 32 }
}
```

Timeouts are staggered so they do not fire together:

| Key | Default | Meaning |
|---|---|---|
| `stallMs` | 300000 (5 min) | No session events. Paused during `tool_execution_start`…`end` and while a `need_decision` is pending. Streaming providers emit `message_update` on `thinking_delta` / `text_delta` (pi agent-loop), which resets this. Not every provider streams partial thinking, so 2 min can kill a slow reasoning turn; 5 min is the default. |
| `decisionTimeoutMs` | 600000 (10 min) | Parent did not reply to `need_decision`. |
| `timeoutMs` | 1800000 (30 min) | Hard cap on one child generation. |

## Manager CLI

Operations manual (every subcommand, fuzzy ids, output formats): **[docs/cli.md](docs/cli.md)**. Everything the TUI shows can also be answered from the CLI:

| Question | Command |
|---|---|
| Is the daemon healthy? | `pbs-manager doctor` (non-zero exit on any failure), `pbs-manager status` |
| What is each pi session doing, and where? | `pbs-manager sessions [-a]` (PID, state, CWD, running/tasks/agents) |
| What is running / just finished? | `pbs-manager ls [-a] [--session P] [--cwd DIR] [--since 10m] [--json]` (KIND, CWD, STATUS, DUR, EXIT, REASON) |
| Why did this end? What did it print? | `pbs-manager show <id>` (shell, monitor, `ch_…` agent or `run_…`) |
| What did this subagent do? | `pbs-manager agent <ch_id> [-f] [--full]` (live transcript) |
| Why didn't a notification arrive? | `pbs-manager events [-f] [--id X]` (task lifecycle + wake emit/deliver/dedupe/drop) |
| Follow output | `pbs-manager tail <id>`, `pbs-manager log -f <id> [--stderr]` |

Ids are fuzzy (unique prefix/suffix/near-miss). State directory: `~/.pi/agent/pbs/` (`PBS_HOME` / `--home`).

## TUI (interactive mode)

| Surface | Behavior |
|---------|----------|
| Fleet line (below editor) | One row of live work only: `● 2 shells · 1 monitor · alpha 12s   /tasks`. Running subagents by name; anything that exited, failed or was killed drops out, and the row disappears when nothing runs |
| `/tasks` (alias `/bashes`) | Live list of shells, monitors and subagents (grouped by run). Type to filter; ↑↓ / PgUp / PgDn / Home / End move; Tab switches active+recent vs all; Enter opens details; `ctrl+x` stops (inline confirm); Esc closes |
| Finished items | Stay listed for 10 minutes (cap 50). Commands that finished inside the foreground budget are not background work and are not listed |
| Shell / monitor details | `1` output · `2` stderr · `3` info (status, exit, end reason, times, paths). Tab cycles, `f` toggles follow, arrows / PgUp / PgDn / wheel scroll, Esc back |
| Subagent details | Conversation (agent preamble hidden), result, info |
| `/reply <child> <text>` | Answer a subagent's decision request without going through the model |
| Transcript rows | A backgrounded bash call is one row that updates when the command finishes |
| Notification pills | One line per wake (✓ done, ✗ failed, › monitor event, ? decision request). Ctrl+O expands labelled fields; the XML envelope is model-facing only |

Print mode (`pi -p`) skips widgets; notifications still inject as before.

```bash
cd manager && cargo test                        # Rust: unit + adversarial + protocol + observability
cd manager && cargo test --features test-clock  # same suites on a manual clock (fast)
cd extension && npx tsc --noEmit && npx vitest run
PBS_INTEG=1 npx vitest run tests/integration/real-manager.test.ts  # TS ↔ real daemon
```

Manual acceptance checklist: [docs/testing-guide.md](docs/testing-guide.md).
