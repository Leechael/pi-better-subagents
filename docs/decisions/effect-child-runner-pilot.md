# Effect-TS child runner pilot

**Status:** completed on `pilot/effect-runner`; production wiring uses the pilot implementation.  
**Decision:** keep the bounded Effect use for child lifecycle, registry admission, and virtual-clock tests; do not expand Effect usage to unrelated extension modules without another measured pilot.

## Scope and outcome

The pilot directly replaces the Promise/global-timer child runner:

- `EffectChildRunner` uses `Deferred` for generation results, `Ref` for exactly-once settlement, `Scope` and `Fiber` for timer ownership/cancellation, and `Clock`/`Duration` for timeout and stall deadlines.
- `SubagentRegistry` uses Effect's FIFO semaphore for concurrent-child slots. Its Promise-facing API and the pi `CreateSessionFn` boundary remain unchanged.
- The child session adapter is still Promise-based because pi exposes Promise APIs. Effect does not wrap or replace the pi runtime.
- Production wiring and registry/tool/integration tests now exercise `EffectChildRunner`; the previous `InProcessRunner` implementation was removed.
- The Effect lifecycle suite has active `TestClock` cases for hard timeout, disposal, activity-reset stall time, resume generations, pending supervisor decisions, tool execution, settled-event behavior, and event timestamps. Existing registry tests exercise admission, FIFO behavior, and release paths.

The pilot does **not** make arbitrary JavaScript state transitions type-safe or automatically eliminate lifecycle bugs. The value demonstrated here is explicit ownership of timer fibers/scopes, a controllable clock at the runner boundary, and a FIFO admission primitive. Behavioral tests remain essential.

## Measurements

Measurements were taken on Node **v24.21.0**. Values below are fresh-process samples (10 runs); medians and nearest-rank p90 are reported. The pi load comparison used paired runs. One baseline sample was a cold-start outlier at 790 ms (retained in the sample; it does not affect the reported median or p90).

| Variant | Measurement | Median | p90 |
| --- | --- | ---: | ---: |
| Actual pilot deep imports | Parallel imports of `effect/Clock`, `Deferred`, `Duration`, `Effect`, `Exit`, `Fiber`, `Ref`, and `Scope` | 66.36 ms | 67.46 ms |
| Tree-shaken ESM bundle | Entry imports the actual `EffectChildRunner` and `SubagentRegistry`; esbuild 0.28.2, `platform=node`, tree shaking on | 536,869 B raw / 112,509 B gzip | — |
| Bundle import | Fresh Node process imports the generated bundle | 19.87 ms | 21.44 ms |
| pi/jiti extension load, TypeScript 7 baseline at `16dd3d1` | `pi -ne -e ./src/index.ts --mode rpc --no-session -p ''` | 265 ms | 280 ms |
| pi/jiti extension load, Effect pilot | Same command against the pilot extension | 320 ms | 340 ms |
| Paired pi/jiti overhead | Pilot minus baseline, same-order paired runs | +60 ms | +60 ms |

The unbundled `effect@3.22.2` package occupies **33 MB** on disk in this install. This extension currently runs TypeScript through pi/jiti rather than shipping a bundle, so it pays the measured import/startup cost and needs the Effect package installed. The bundle measurement is an alternative deployment shape, not the current one.

A prior minimal pilot-shaped bundle measured 324,306 B raw / 67,940 B gzip. The source-backed runner+registry bundle above is the more representative figure and is larger because it includes the actual pilot modules and their reachable code.

## TypeScript 7 upgrade

The branch was upgraded to TypeScript **7.0.2** before the pilot. On the same working tree, `npm run typecheck` measured **3.68 s before** and **0.74 s on the first post-upgrade run**; another post-upgrade run measured **3.14 s**, showing substantial process/cache variance. Do not treat one timing as a stable compiler speedup. No source or `tsconfig` compatibility fixes were required; Vitest and the suite continued to run. A repository search found no dependency on TypeScript's old JavaScript compiler API (`createProgram`, `createSourceFile`, `transpileModule`, `tsserverlibrary`, or `typescript/lib`).

## Verification

- TypeScript 7.0.2 typecheck passed after the upgrade and after the Effect replacement.
- Final pilot suite: **313 passed, 9 skipped**; the nine skips are the separately opt-in real-manager integration tests. No new Effect lifecycle tests remain skipped.
- `npm test` full-suite wall duration in the final run: **3.58 s** (Vitest-reported 3.09 s test time); concurrent benchmark/test activity can change wall duration.
- No manager code was changed for the pilot. No changes were pushed or squashed.

## Follow-up boundary

Keep Effect imports centralized in `extension/src/subagent/effect-imports.ts` and restricted to public deep subpaths. Expand only when another measured lifecycle or concurrency seam has a concrete ownership/testing benefit that justifies its import and startup cost. The existing Promise adapter at pi's session boundary is intentional.