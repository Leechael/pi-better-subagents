# eval/ — does each prompt and mechanism earn its place?

Two layers, one harness:

| Layer | What it tests | Model | Cost |
|---|---|---|---|
| **E2E** (`e2e/`) | The code: real `pi` + real `pbs-manager` + this extension, driven by a scripted faux model | faux | free |
| **Ablation** (`ablation/`) | The model: remove one prompt segment or mechanism at a time and measure the pass-rate drop on small behavioral probes | real models | see below |

Every episode spawns the installed `pi` in RPC mode (`pi --mode rpc -ne -ns -np -nc --no-session --offline -e ../extension …`) in a temp cwd with its own `PBS_HOME` (own manager socket, `config.json`, task logs). RPC mode rather than `-p`: print mode exits as soon as the first run settles, so later wakes would never be seen.

## Prerequisites

- Node ≥ 22.18 (runs `.ts` directly; no build step)
- `pi` on `PATH` (tested with 0.87) — override with `PI_BIN`
- `cargo`: `pbs-manager` is built from `../manager` into `eval/.cache/target` on first use (never inside `manager/`); override with `PBS_MANAGER_PATH`
- `tmux` for the TUI test
- `npm install` in `eval/` is only needed for `npm run typecheck`

Extension under test: `../extension` (override with `PBS_EVAL_EXTENSION`).

## E2E (free)

```bash
npm run test:e2e      # faux scenarios + ablation-harness self-test   (~15s)
npm run test:tui      # PBS_E2E_TUI=1: tmux-driven interactive pi, asserts no line wider than the pane
npm run test:unit     # wake adapter, Wilson/early-stopping stats, report verdicts
npm run test:graders  # real-model graders run on scripted good/bad behaviors (~2 min)
npm run typecheck
```

`test:graders` proves each grader can go both green and red (a grader that cannot fail is a placebo). The `supervisor-reply/send` case deliberately takes ~2 minutes: the child stays blocked until the episode cap.

Faux scripts live in `e2e/scripts/`; the DSL is `e2e/faux-dsl.ts`. Scripts run inside the pi process, and every model call (with its full context) is traced, so tests can assert what the model actually saw. `PBS_EVAL_KEEP=1` keeps sandboxes.

## Ablation (real models)

### Models and auth

`eval/models.json` lists model specs exactly as `pi --model` takes them (`provider/id[:thinking]`); the first entry is the smoke model. Override per run with `--models a,b`.

The eval never reads keys or `auth.json`. Each episode is the user's own `pi --model <spec>`, which resolves credentials (including OAuth refresh) the normal way. Models are validated against what pi can authenticate (RPC `get_available_models`) before anything runs. See what is available:

```bash
pi -ne --list-models
```

### Tiers

```bash
node ablation/run.ts --tier smoke            # prints the plan + cost estimate, runs nothing
node ablation/run.ts --tier smoke --yes      # 1 model × baseline × 8 scenarios × k=3
node ablation/run.ts --tier full --yes       # all models × (baseline + every ablatable segment + groups) × k=10
node ablation/report.ts                      # tables + verdicts (reads results/results.jsonl)
```

Useful flags: `--models`, `--scenarios bg-end-turn,no-fabrication`, `--variants baseline,wake.lead-in`, `--k N`, `--concurrency N` (default 3), `--pairs all` (default only pairs listed in a segment's `affects`), `--max-episodes N`, `--transcripts` (save event streams), `--judge <model>` (optional LLM judge for fuzzy criteria, recorded as `metrics.judge`, never overrides the programmatic grade), `--results FILE`.

**Cost.** Without `--yes` the runner only prints the plan and a list-price upper bound per model (from pi's model catalog, assuming ~2.5k fresh + 6k cached input and ~450 output tokens per call). Early stopping usually cuts the full tier well below the bound; OAuth/subscription providers may bill nothing. The report shows the parent-session cost pi reported; child-session usage is not included.

**Resumable.** Results append to `results/results.jsonl` (gitignored). Re-running the same command skips cells that already have k scored episodes.

**Early stopping.** Baselines run first. A variant stops as soon as its 95% Wilson interval is entirely below or above `baseline − 20pp`. Variants of a (model, scenario) whose baseline is below 20% are skipped ("floor"): no drop of 20pp is possible there.

### Scenarios (`ablation/scenarios.ts`)

| id | passes when the model… |
|---|---|
| `bg-end-turn` | ends its turn after a command is backgrounded (no polling) and answers from the wake |
| `wake-continue` | acts on a task wake (writes the derived result), not just acknowledges it |
| `still-running-continue` | continues from one task's wake while another still runs |
| `handover-continue` | continues from a per-child `subagent-handover` before the run finishes |
| `monitor-not-sleep` | waits event-driven (monitor, or a backgrounded `tail -F … \| grep -m1`), never a sleep/poll loop |
| `no-fabrication` | never states the result before the wake (canary generated at run time) |
| `supervisor-reply` | answers a `supervisor-request` with `agent_message` `reply` |
| `resume-finished` | resumes a finished child via `subagent({action:"resume"})` (an `agent_message` attempt first is recorded, still a pass) |

Each grade is PASS / FAIL / INVALID (setup precondition not met, e.g. the command finished before the budget). Invalid and errored episodes are excluded from rates.

### Reading the report

Per model, a variant × scenario matrix: `pass% (passes/n) [95% Wilson CI]`, and for variants `Δ` vs baseline in percentage points. `▼` marks a drop ≥ 20pp. `(k vacuous)` means the removed text never appeared in k of those episodes (surface not reached), so they equal baseline.

Segment verdicts:

- **load-bearing** — removing it dropped the pass rate by ≥ 20pp on at least one (model, scenario).
- **slop** — tested and never load-bearing. Candidate for deletion (check the CI width first: with small n a real effect can hide).
- **untested** — no scored cell (not in any `affects`, or floor/no baseline).
- **not ablatable** — only child sessions see it (see below).

`rules.pi-env` is a **control**: if it ever comes out load-bearing, the differences are noise and the run needs more k.

### What gets ablated, and how (`harness/ablation-ext.ts`, `ablation/manifest.json`)

The ablation harness is a separate pi extension loaded after ours; the extension itself is never edited.

- `before_agent_start` edits `systemPromptOptions` in place (the `pi-better-subagents` section, `<rules>` guidelines). These persist, so wake-triggered turns are ablated too.
- `context_with_system` strips segments from every request: tool declarations, tool results, and wakes (the shared `PBS_WAKE_LEAD_IN`, `<reply-with>`). Non-destructive: the session keeps the original text.
- `tool_call` disables the bare-sleep guard (`mech.sleep-block`); `mech.autobg` is disabled via `config.json`.

Segment texts must match the source exactly. Where possible they are read from the extension (`textFrom`, e.g. `wake.PBS_WAKE_LEAD_IN`) instead of copied. `npm run test:e2e` fails on any drift, and verifies every removal happened and that no removed text is still visible.

**Not ablatable externally:** anything only child sessions see (`child.guidelines` = `CHILD_BEHAVIOR_GUIDELINES`, child tool descriptions). By design, children load no extensions, so no hook runs there. These segments are drift-guarded in child calls but never scheduled. Wake delivery itself (triggerTurn vs steer routing, coalescing) has no interception hook either.

## Layout

```
lib/        rpc.ts (pi RPC driver) · sandbox.ts · transcript.ts · wake-adapter.ts (only module that parses <pbs-wake>) · models.ts · paths.ts
harness/    faux-ext.ts (scripted model) · ablation-ext.ts
e2e/        faux.test.ts · ablation-harness.test.ts · tui.test.ts · faux-dsl.ts · scripts/
ablation/   manifest.json · scenarios.ts · graders.ts · episode.ts · run.ts · report.ts · stats.ts · judge.ts · fixtures/
```

When the wake format changes, update `lib/wake-adapter.ts` (and the manifest if prompt text moved); graders consume the normalized `Wake` and should not change.
