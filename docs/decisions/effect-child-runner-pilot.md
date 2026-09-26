# Effect-TS child runner pilot

**Status:** Rejected. The pilot is preserved on `pilot/effect-runner`; `prelaunch-polish` briefly merged it for review history, then restored the Promise implementation.  
**Decision:** Do not adopt Effect in the extension. Continue with the Promise runner/registry and the separately approved explicit `Clock` plus per-generation `TimerScope` design.

## Scope and outcome

The isolated pilot replaced the child runner and registry admission on `pilot/effect-runner`:

- `EffectChildRunner` used `Deferred` for generation results, `Ref` for settlement state, `Scope`/`Fiber` for timer ownership, and `Clock`/`Duration` for timeout and stall deadlines.
- `SubagentRegistry` used Effect's FIFO semaphore for concurrent-child slots.
- Production wiring and the registry/tool/integration tests exercised the Effect implementation. The pilot branch removed the old `InProcessRunner` rather than keeping two production implementations.
- pi's session API remained Promise-based, so the runner needed Promise edges for session calls, `start`/`resume`/`interrupt`, and the child result surface.

The pilot was merged to `prelaunch-polish` for history, verified green, then reverted. The pilot branch remains available for comparison; no push was made.

## Decision rationale

The pilot's costs outweighed its benefits:

- Runner source grew from **439 to 481 LOC** (+42). Registry source changed from **565 to 554 LOC** (−11), for **1,004 to 1,035 LOC** combined (+31).
- Associated runner/registry/tool/integration tests were **1,212 LOC before** and **1,345 LOC in the pilot** (+133, including the new TestClock suite). Combined source and tests grew from **2,216 to 2,380 LOC** (+164).
- The unbundled `effect@3.22.2` dependency occupied **33 MB** on disk and added about **60 ms median** to pi's extension startup.
- Effect did not make lifecycle scenarios test-free or prevent all state-machine bugs structurally; every behavioral test remained necessary.
- TestClock tests needed extra scheduling and callback-flush helpers (`awaitScheduledTimer` / `flushQueuedTimerCallback`). TestClock controls Effect's clock, not arbitrary native timers.

The structural property worth keeping is **per-generation timer ownership**: settling, interrupting, resuming, or disposing a generation must cancel its timers so they cannot affect a later generation. The plain `TimerScope` provides that guarantee without a second lifecycle paradigm or dependency.

Keep the pilot's scenario list as the contract for ManualClock regression tests: timeout mid-tool then resume; stall pause during tool execution and pending decision; events after settlement; disposal closes generation timers; fail-fast while queued; and exactly-once permit release.

## Measurements

Measurements were taken on Node **v24.21.0**. Import and bundle figures are 10 fresh-process runs; medians and nearest-rank p90 are reported. The pi load comparison used paired runs. One baseline sample was a cold-start outlier at 790 ms (retained in the sample; it does not affect median or p90).

| Variant | Measurement | Median | p90 |
| --- | --- | ---: | ---: |
| Actual pilot deep imports | Parallel imports of `effect/Clock`, `Deferred`, `Duration`, `Effect`, `Exit`, `Fiber`, `Ref`, and `Scope` | 66.36 ms | 67.46 ms |
| Tree-shaken ESM bundle | Entry imports the actual `EffectChildRunner` and `SubagentRegistry`; esbuild 0.28.2, `platform=node`, tree shaking on | 536,869 B raw / 112,509 B gzip | — |
| Bundle import | Fresh Node process imports the generated bundle | 19.87 ms | 21.44 ms |
| pi/jiti extension load, TypeScript 7 baseline at `16dd3d1` | `pi -ne -e ./src/index.ts --mode rpc --no-session -p ''` | 265 ms | 280 ms |
| pi/jiti extension load, Effect pilot | Same command against the pilot extension | 320 ms | 340 ms |
| Paired pi/jiti overhead | Pilot minus baseline, same-order paired runs | +60 ms | +60 ms |

The extension does not ship a bundle, so the bundle is an alternative deployment measurement, not the current runtime shape. A prior minimal pilot-shaped bundle measured 324,306 B raw / 67,940 B gzip; the source-backed runner+registry bundle is the more representative figure.

## TypeScript 7 upgrade

TypeScript **7.0.2** was upgraded before the Effect pilot. On the same working tree, `npm run typecheck` measured **3.68 s before** and **0.74 s** on the first post-upgrade run; another post-upgrade run measured **3.14 s**, showing process/cache variance. No source or `tsconfig` compatibility fixes were required. A repository search found no dependency on TypeScript's old JavaScript compiler API (`createProgram`, `createSourceFile`, `transpileModule`, `tsserverlibrary`, or `typescript/lib`). TypeScript 7 remains on `prelaunch-polish`.

## Verification

- The merged pilot passed TypeScript 7.0.2 typecheck and the full suite: **313 passed, 9 skipped**. The nine skips were the separately opt-in real-manager integration tests.
- The final pilot full-suite wall duration was **3.58 s** (Vitest reported 3.09 s test time).
- Immediately after the revert, TypeScript 7.0.2 typecheck passed and the Promise implementation suite reported **312 passed, 9 skipped** (real-manager integration), with 2.93 s full-suite wall duration.
- The plain Clock follow-up is now implemented in commits `9741bc6`, `40dd506`, `094bc73`, `529c76b`, and `cabd089`. Final `npm run typecheck` passed; `npm test` reports **319 passed, 9 skipped** (opt-in real-manager integration), **2.28 s** full-suite wall duration (Vitest-reported 1.50 s test time).
- ManualClock now covers clock semantics, runner lifecycle (timeout mid-tool/resume, tool and decision pauses, late events, disposal), registry fail-fast/admission, subagent budget, child-bash deadlines, mailbox decisions, monitor batching/rate limiting, and task age. No contract or unit test uses Vitest fake timers or wall-time polling for timer semantics; remaining real-time waits are listed below.
- Remaining real time is intentional: fake-manager Unix-socket client tests exercise actual socket delivery and reconnect/backoff; the sparse-file tail test measures real elapsed performance; opt-in real-manager integration tests exercise the real process/socket boundary. These require the real event loop or real I/O, not synthetic timer semantics.
- No manager code was changed for the pilot. `.claude/` remains untracked and outside the commits.
