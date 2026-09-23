# Manual acceptance guide

About 20 minutes. It walks every feature the way a user meets it, and says what you should see. Anything that doesn't match is a bug. Note the step number and run `pbs-manager doctor` and `pbs-manager events --since 10m` to attach to the report.

Automated suites (run first, all must be green):

```bash
cd manager && cargo test && cargo test --features test-clock
cd extension && npm ci && npx tsc --noEmit && npx vitest run
PBS_INTEG=1 npx vitest run tests/integration/real-manager.test.ts
cd eval && npm run test:e2e && npm run test:unit      # faux-model end-to-end, no model cost
```

## 0. Install

```bash
cd manager && cargo build --release
mkdir -p ~/.pi/agent/pbs/bin
install -m 755 target/release/pbs-manager ~/.pi/agent/pbs/bin/pbs-manager   # atomic replace (macOS code signing)
pbs-manager shutdown 2>/dev/null   # make sure no older daemon keeps running
pi -ne -e /path/to/pi-better-subagents/extension
```

`-ne` keeps other extensions (e.g. an installed `pi-subagents`) out of the way. Keep a second terminal open for the CLI steps.

## F1. Bash auto-background

| # | Do | Expect |
|---|---|---|
| 1.1 | Ask: "run `sleep 30 && echo done` with bash" | After ~20s the tool row becomes one line `⏵ sh_… running in background · /tasks`. The agent ends its turn instead of polling. The fleet line shows `● 1 shell … /tasks` |
| 1.2 | Wait | A `✓ task …` pill appears, the agent resumes on its own and mentions `done`. The tool row from 1.1 now reads `✓ sh_… finished · exit 0 · 30.0s` |
| 1.3 | Ask it to run three commands in the background that sleep 5, 10, 15s | Three separate wakes. The first two list the others under "still running" (Ctrl+O on the pill) |
| 1.4 | Ask for `false` in the background | `✗` pill with exit 1; the row turns `✗ … failed · exit 1` |
| 1.5 | Ask: "sleep 60 to wait" | Refused with guidance (bare sleep blocked) |

## F2. Monitor

| # | Do | Expect |
|---|---|---|
| 2.1 | Ask for a monitor on `while true; do date; sleep 2; done`, timeout 20s | `› monitor …` pills while events flow (merged while the agent is busy), then a timeout notice. The tool row shows the monitor as a failure if the manager is missing (F7.5) |
| 2.2 | Ask for a monitor on `yes \| head -c 100000000` | Drops are reported (`dropped-lines`), and after sustained saturation the monitor stops itself with a rate-limit notice; it does not wake the model every 2 s until timeout |
| 2.3 | `/tasks` during 2.1 | The monitor is listed; Enter → output tab shows its lines |

## F3. Subagents

| # | Do | Expect |
|---|---|---|
| 3.1 | "Use two subagents in parallel: one lists files, one sleeps 60 s via bash then reports" | After 45 s the tool row turns into `run run_… · running · /tasks` with one line per child. The fast child's result arrives as a handover wake while the other still runs; the agent continues right away |
| 3.2 | Wait | A `subagent-done` pill with per-child counts; the fleet line drops the children |
| 3.3 | `/tasks` → select a child → Enter | Conversation (no agent preamble), result, info tabs |
| 3.4 | Use a model that fails (e.g. a provider without credits) for a subagent | Child is `✗ failed` with the provider error, in the pill, `/tasks`, and `pbs-manager show ch_…` (`reason model-error`) |
| 3.5 | Ask for a subagent that must ask you a question (it uses `contact_supervisor`) | `? decision for <name>` pill; answer with `/reply <child> <text>`; the child continues |

## F4. `/tasks`

| # | Do | Expect |
|---|---|---|
| 4.1 | Open with several items | Grouped list (subagents under their run), coloured glyphs, exit/reason inline, `(i/n)` when it scrolls |
| 4.2 | Type letters | Filters the list (typing never triggers an action) |
| 4.3 | `ctrl+x` on a running item | Inline red confirm; Enter stops it, Esc cancels. On a finished item: a muted "already finished" hint, nothing written to the transcript |
| 4.4 | Tab | Switches active+recent ↔ all |
| 4.5 | Enter on a shell | `1` output · `2` stderr · `3` info (status, exit, reason, times, paths); `f` toggles follow |
| 4.6 | Resize the terminal to 60 and to 40 columns while open | Nothing wraps or overflows; pi does not exit with "Rendered line exceeds terminal width" |

## F5. Fleet line and pills

| # | Do | Expect |
|---|---|---|
| 5.1 | During F1–F3 | One row: `● 1 shell · 1 monitor · alpha 12s · ✗ 1 failed   /tasks` |
| 5.2 | After a failure, with nothing running | The row stays with `✗ 1 failed` for up to 10 minutes |
| 5.3 | Ctrl+O on any pill | Labelled fields (command, exit, duration, preview…), never raw XML |
| 5.4 | CJK text in commands/results | Columns stay aligned |

## F6. CLI (second terminal)

| # | Do | Expect |
|---|---|---|
| 6.1 | `pbs-manager status` · `pbs-manager doctor` | Version/protocol/uptime; doctor all OK, exit 0 |
| 6.2 | `pbs-manager sessions` / `sessions -a` | Your pi session with PID and CWD; `-a` also shows gone sessions |
| 6.3 | `pbs-manager ls` / `ls -a` | KIND (shell/monitor/agent), SESSION prefix, CWD, STATUS, DUR, EXIT, REASON |
| 6.4 | `pbs-manager show <id>` for a shell, a monitor, a `ch_…`, a `run_…` (fuzzy ids ok) | Everything about it; for an agent: model, error, reason, tool calls, result tail |
| 6.5 | `pbs-manager agent ch_… -f` while a child runs | Live transcript; `--full` also shows the preamble |
| 6.6 | `pbs-manager events -f` while running F1 | `task.start`, `task.background`, `task.exit`, `wake.emit`, `wake.deliver mode=…` |
| 6.7 | `pbs-manager output <id> \| head` | No panic on the closed pipe |
| 6.8 | `pbs-manager stop ch_…` | Explains agents run inside pi (stop from `/tasks`) |

## F7. Manager lifecycle and degraded mode

| # | Do | Expect |
|---|---|---|
| 7.1 | Start a background `sleep 300`, quit pi | Within ~7 s `pbs-manager status` says not running (exit 1) and the sleep is gone (`pgrep -f 'sleep 300'` empty) |
| 7.2 | Two pi sessions at once, then quit one | Daemon stays; `sessions` shows one connected, one gone |
| 7.3 | `kill -9` the daemon while a background task runs, then run any bash in pi | The extension reconnects/respawns; `ls -a` shows the task re-adopted or `orphaned` |
| 7.4 | Background a command that spawns `sleep 300 &` and exits; quit pi | The grandchild `sleep 300` is gone too |
| 7.5 | Move the manager binary away, start pi | Warning lists the paths tried and says children lose bash; bash still runs locally; monitor/`task_*` report disabled (red); `/tasks` says the manager is unavailable |

## Prompt eval (optional, costs model credits)

See [eval/README.md](../eval/README.md). The smoke tier runs one model × 8 scenarios × 3 repeats (about $4 at list price); pick models in `eval/models.json`, authentication comes from your `pi` login.
