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

Degradation when the manager is missing: bash falls back to local execution, task_*/monitor are disabled (a warning shows in the TUI). Point to a binary explicitly via `PBS_MANAGER_PATH` or `managerPath` in config.json.

## Tools

### bash (overrides the built-in)
Adds a `run_in_background` parameter. Foreground commands that exceed `foregroundBudgetMs` (default 20s) move to the background automatically; completion arrives as a `<task-notification>`. Bare `sleep` commands are rejected (use monitor or the background flag instead).

### subagent
```
subagent({ tasks: [{agent?, prompt, name?}], ... })   // parallel, ≤10, concurrency 1..8
subagent({ chain: [{agent?, prompt, label?}], ... })  // serial, {previous}/{outputs.<label>} interpolation
subagent({ action: "list|get|status|interrupt|resume|steer|models", run_id?, child_id?, message? })
```
- Synchronous wait up to 45s (`subagent.budgetMs`); on expiry the run continues in the background with a `run_id`, and completion arrives via `<subagent-notification>`. **Never poll.**
- `model` accepts fuzzy specs (`"haiku"`, `"openai/gpt-5.2"`, `"luna:high"`); the candidate set respects pi's whitelist (`enabledModels` / `--models`). Use `action:"models"` to list selectable values before choosing.
- Subagents run in-process via `createAgentSession`, capped at depth 1 (no nesting), with a no-background bash variant, and a 10-minute stall watchdog.

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
Children additionally get `contact_supervisor({ reason: "need_decision"|"progress_update", message })` — `need_decision` blocks the child until the parent replies (10-minute timeout).

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
  "subagent": { "budgetMs": 45000, "timeoutMs": 600000, "stallMs": 600000,
                "concurrency": 4, "maxConcurrentChildren": 8, "spawnBudgetPerHour": 32 }
}
```

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
| Fleet line (below editor) | `2 workers · 1 subagent · 1 monitor · 4 tasks` — counts only, no keys |
| `/tasks` | Running subagents, monitors, and shell workers. View or stop |
| Subagent view | That child's conversation. Stays listed after it finishes only while the view is open |
| Monitor / shell view | Two pages: merged output, and stderr. Wheel / PgUp / PgDn scroll; terminal selection copies |
| Transcript pills | Compact renderers for task / subagent / **monitor** / supervisor notifications |
| Monitor events | Injected as `Monitor event: "desc"` + `<event>` body (model turn / steer); lifecycle (exit / timeout / rate-limit) also fires a TUI toast |
| Monitor tool row | `Monitor started · task <id> · timeout 300s` |

Print mode (`pi -p`) skips widgets; notifications still inject as before.

```bash
cd manager && cargo test                             # Rust: 24 unit + 12 protocol black-box
cd extension && npx tsc --noEmit && npx vitest run   # TS: 253 tests
PBS_INTEG=1 npx vitest run tests/integration/real-manager.test.ts  # TS↔real daemon e2e (9)
```
