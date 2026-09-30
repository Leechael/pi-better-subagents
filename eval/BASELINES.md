# Model baselines

What each model scores on the smoke tier (baseline prompt only, 8 scenarios, k=10), and so which models the extension can be used with.

## When to rerun

Rerun this before merging any change to:

- how wakes are delivered (`notify.ts`, monitor/task exit handling, the exit watchdog);
- any text the model sees from the extension: tool descriptions, tool results, behavior guidelines, wake text. Everything with a segment in `ablation/manifest.json` counts.

Rerun every model in the table below, at the thinking level listed. Write to a new results file, so the runner does not skip cells scored by an earlier version. Then add a section here, newest first, and update the summary.

**All scenarios, or only the affected ones.** Rerun all eight when the change reaches every episode (guidelines, a tool description, wake text, how every wake is delivered). When it reaches only a path that some scenarios exercise, rerun those (`--scenarios a,b`), and say in the run's section which path changed, why the other scenarios cannot reach it, and how you checked (for example, counting the tool calls that lead there in the previous run's transcripts). The summary then combines runs; its Runs column names each one.

```bash
cd eval
node ablation/run.ts --tier smoke --k 10 --transcripts \
  --models <spec>,<spec>,... \
  --results results/<run>/results.jsonl --yes
node ablation/report.ts --results results/<run>/results.jsonl
```

Record which code ran as the tree hash of `extension/` (`git rev-parse --short HEAD:extension`): unlike a commit hash, it survives a rebase of the stack.

Read the transcript of every FAIL and INVALID before writing the numbers down: graders have failed correct runs before (see PR #18). Record both the grader's count and the reviewed count, and say why they differ.

**Thinking level.** The spec's level is not always the level pi sends. Where a model's `thinkingLevelMap` maps a level to `null`, pi runs it at another level. Check it in any transcript (`"thinkingLevel":"…"` in the session state) and record both.

## Summary

Latest run per model, after review. Pass + fail is the 80 scored episodes (8 scenarios × 10); INVALID episodes are rerun, so they come on top. gpt-6-sol and gpt-5.6-luna show 79: review turned one FAIL each into INVALID after the run had ended, so no replacement episode ran.

| Model spec | pi ran at | Run | Pass | Fail | Invalid | Usable |
|---|---|---|---|---|---|---|
| `openai-codex/gpt-6.1-sol:medium` | medium | 2026-09-30b | 80 | 0 | 1 | yes |
| `deepseek/deepseek-flash:medium` | **high** | 2026-09-30b | 79 | 1 | 1 | yes |
| `openai-codex/gpt-6-sol:medium` | medium | 2026-09-30a | 79 | 0 | 1 | yes |
| `openai-codex/gpt-6-luna:medium` | medium | 2026-09-30a | 79 | 1 | 0 | yes |
| `openai-codex/gpt-5.6-sol:medium` | medium | 2026-09-30a | 80 | 0 | 0 | yes |
| `openai-codex/gpt-5.6-luna:medium` | medium | 2026-09-30a | 79 | 0 | 11 | yes |
| `openai-codex/gpt-5.6-terra:medium` | medium | 2026-09-30a | 79 | 1 | 1 | yes |
| `xai/grok-4.7:medium` | medium | 2026-09-30a | 80 | 0 | 0 | yes |
| `xai/grok-4.6:medium` | medium | 2026-09-30a | 80 | 0 | 0 | yes |
| `xai/grok-4.5:medium` | medium | 2026-09-30a | 80 | 0 | 1 | yes |
| `xai/grok-4.3:medium` | medium | 2026-09-30a | 61 | 19 | 2 | **no** |
| `kimi-coding/kimi-for-coding:medium` | **high** | 2026-09-30a | 78 | 2 | 0 | yes |
| `kimi-coding/k3-256k:medium` | **high** | 2026-09-30a | 80 | 0 | 2 | yes |

**grok-4.3 is not usable with this extension.** It failed 10 of 10 `bg-end-turn` and 9 of 10 `monitor-not-sleep`: 18 of its 19 failures are repeated checks on background work (`task_output`, `task_list`, `cat` of the log or output file) instead of ending its turn. The same held in all six runs while PRs #17–#20 were written: 9 or 10 failures in 10 on `monitor-not-sleep`, and 5 to 10 on `bg-end-turn`. None of the fixes or wording changes moved it.

## Known gaps in these numbers

- `deferred: fixture scripts contain the secret path (echo "$ID" >> …/secret/build) | impact: a model could read the canary before its wake and pass no-fabrication or answer early; grok-4.3 read or listed it in 4 episodes, none got a token (file missing or empty), no grade affected so far | trigger: any episode reads a canary from secret/ before its wake, or a grader change that relies on canary secrecy`
- `deferred: the background notice prints the output file path | impact: reading it before the wake is a poll the task_output guard does not see; only grok-4.3 has done it, in 4 episodes, no wrong answer came from it | trigger: a model other than grok-4.3 reads the output file before its wake`
- `deferred: a no-guard control (main's extension) on bg-end-turn | impact: unknown whether returning the task_output refusal as a tool error cuts polling or provokes kill-and-retry; every run had the guard | trigger: before changing how the refusal is returned, or a model other than grok-4.3 killing its own task after a refusal`
- Result lines do not keep the episode's canary tokens, so a grader fix cannot re-grade an old run; it has to be reviewed by hand or rerun (2026-09-30a was).

## 2026-09-30b: gpt-6.1-sol, deepseek-flash

- Extension tree `88677a9`; graders as of PR #20.
- 162 episodes, ~$1.31 at list price. deepseek-flash maps `medium` to `null`; pi ran it at `high`.

Recorded by the grader: 159 pass, 1 fail, 2 invalid. Review changed none:

- gpt-6.1-sol `wake-continue` #9, INVALID: the model's first response never arrived within the 76s the episode ran (a provider stall; the transcript has one pending assistant message and nothing after).
- deepseek-flash `still-running-continue` #2, INVALID: the backgrounded command wrote quick.txt itself (`./quick.sh > quick.txt`). The model did only read it after the wake.
- deepseek-flash `monitor-not-sleep` #4, FAIL: armed the monitor, said it would wait, then called `task_list` once before ending its turn.

## 2026-09-30a: eleven models

- Extension tree `88677a9`, the same code as 2026-09-30b.
- Graders: from before PR #18's last two commits (a script counts only when invoked, `mv`/`cp` count as writes; episodes that never exercised the behavior are INVALID); the reviewed column applies them by hand (the episodes' canaries were deleted with the sandboxes, so they could not be re-graded).
- 896 episodes, ~$14.46 at list price.

Recorded by the grader: 854 pass, 26 fail, 16 invalid. Review changed three:

| Episode | Recorded | Reviewed | Why |
|---|---|---|---|
| gpt-6-sol `monitor-not-sleep` #2 | FAIL | INVALID | READY was already in the log at its first look: nothing to wait for |
| gpt-5.6-luna `still-running-continue` #10 | FAIL | INVALID | the backgrounded command wrote quick.txt itself (`mktemp` + `mv`); the model never acted on a wake |
| kimi-for-coding `handover-continue` #5 | FAIL | PASS | wrote the file with `cp`, which the grader did not count as a write |

The real failures outside grok-4.3, all read in their transcripts:

- gpt-6-luna `monitor-not-sleep` #9: armed the monitor, then checked on it once before waiting.
- gpt-5.6-terra `still-running-continue` #9: ran slow.sh before quick.sh, so quick.txt was written only after slow finished.
- kimi-for-coding `monitor-not-sleep` #7: checked on the monitor once.
- kimi-for-coding `monitor-not-sleep` #1: its monitor command ended in `| head -n 5`, which held the READY line in a buffer; the event never arrived.

A monitor's exit notice arriving before its event (the regression fixed in PR #19): 0 of 58 monitors.
