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

Operations manual (install, every subcommand, fuzzy ids, workflows): **[docs/cli.md](docs/cli.md)**.

```bash
pbs-manager status|sessions|list|ls|doctor|shutdown
pbs-manager start '<cmd>' | wait <id> | stop <id> | kill-session <sid>
pbs-manager log|tail|output …          # see docs/cli.md
```

`list` / `ls` show running tasks by default; `-a` / `--all` includes exited. State directory: `~/.pi/agent/pbs/` (`PBS_HOME` / `--home`).

## TUI (interactive mode)

Counts sit on one line under the editor. Inspection is `/tasks` (alias `/bashes`), which opens a scrollable full-screen view.

| Surface | Behavior |
|---------|----------|
| Fleet line (below editor) | `2 workers · 1 subagent · 1 monitor` — counts only, no total, no poll |
| `/tasks` | Live list of shells, monitors, and subagents. Filter by typing; ↑↓ select, Tab switches active/recent vs all, PgUp/PgDn page, Enter view, `s` stop (with confirmation), Esc close |
| Finished items | Stay viewable for 10 minutes (cap 50). Sync-waited shells are not workers |
| Shell / monitor details | Output, stderr, and info panes; `1`/`2`/`3` select and Tab cycles. `f` toggles follow; wheel / arrows / PgUp / PgDn scroll |
| Subagent details | Conversation, result, and info panes; prompts and preambles are labelled separately |
| Transcript pills | Compact, labelled renderers for task / subagent / **monitor** / supervisor notifications. Ctrl+O expands details without exposing the XML envelope |
| Monitor events | Injected as `Monitor event: "desc"` + `<event>` body (model turn / steer); lifecycle (exit / timeout / rate-limit) also fires a TUI toast |
| Monitor tool row | `Monitor started · task <id> · timeout 300s` |

Print mode (`pi -p`) skips widgets; notifications still inject as before.

```bash
cd manager && cargo test                             # Rust: 31 unit + 13 protocol (1 RSS test ignored)
cd extension && npx tsc --noEmit && npx vitest run   # TS: 289 passed, 9 skipped
PBS_INTEG=1 npx vitest run tests/integration/real-manager.test.ts  # TS↔real daemon e2e (9)
```
