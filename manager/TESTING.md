# pbs-manager testing

How the manager is tested, what the tests are known to guard, and where the
gaps are. Contract sources: `docs/design.md` §3 and `docs/cli.md`.

## Suites

| Suite | Kind | What it covers |
|---|---|---|
| `src/**` `#[cfg(test)]` | unit | ring buffer, record persistence, state mapping, daemon lock claim, UTF-8 chunk cutting, signal names, id format, manual clock (`test-clock` only) |
| `tests/protocol.rs` | black box | message round-trips, basic lifecycle (t01–t13) |
| `tests/lifecycle_adversarial.rs` | black box | every cell of the lifecycle table below, adversarial conditions |
| `tests/mutation_gaps.rs` | black box | behaviours found unguarded by cargo-mutants survivors (g1–g14) |
| `tests/observability.rs` | black box | observability contract: protocol additions, events.jsonl, inspection CLI (p1–p3, e1–e4, c1–c8) |
| `tests/timing_canary.rs` | black box, real time | the actual 5s idle grace and 2s kill grace (always on the real clock) |
| `tests/common/mod.rs` | helpers | wire client, isolated `--home`, process probes, crashable helper client, clock stepping (`Home::advance*`) |

All black-box tests start the compiled binary with an isolated `--home`
(`$TMPDIR/pbsx-<pid>-<test>`, kept short for the ~104-byte socket path
limit) and speak the u32-BE + JSON protocol directly. They depend only on
`serde_json` and `libc`, which are already regular dependencies, so there
are **no new dev-dependencies**.

Determinism rules:

- Every wait is a poll with a deadline (`poll_until`). The daemon's own
  timers are stepped, not waited for: see [Time in tests](#time-in-tests).
- A crashing pi is a real separate OS process: the test binary re-executes
  itself as `helper_hold_extension_conn` (an ignored no-op test when run
  normally), which connects, starts tasks, and is then SIGKILLed.
- Race tests (`d2`) add CPU burners (one per core) for the test's duration
  to widen scheduler windows; this made the original race fail every time.
- Cleanup: each `Home` kills every recorded task process group and the
  daemon on drop, even when the test panics.

```bash
cd manager
cargo test --features test-clock                         # everything, manual clock (~44s wall)
cargo test                                               # everything, real time (~59s wall)
cargo test --test lifecycle_adversarial                  # adversarial suite
scripts/ablate.sh                                        # ablation check (~8 min, manual clock)
cargo mutants -j 3 --timeout 150 -f src/lifecycle.rs -f src/task.rs -f src/registry.rs \
  -f src/daemon.rs -f src/sys.rs -f src/proto.rs          # mutation score (manual clock via .cargo/mutants.toml)
```

Measured on an M-series Mac with a warm build (129 passing tests with the
feature, 127 without; the difference is the two `clock` unit tests):

| | `cargo test` wall | per-test time, summed serially | `cargo mutants -f src/lifecycle.rs` (42 mutants, -j 3) |
|---|---|---|---|
| before (real time only) | 48s (50s re-measured) | 182s | 324s |
| `--features test-clock` | 44s | 77s | 226s (−30%) |
| plain, after | 59s (+2 canaries, 8s) | — | — |

Per binary with the feature: unit 0.2s, `lifecycle_adversarial` 18s,
`mutation_gaps` 2.6s (was 14s), `observability` 2.3s (was 5s), `protocol`
7.6s, `timing_canary` 7.7s. Binaries run one after another; tests inside a
binary run in parallel. The wall time is now bounded by tests that are not
about the timers: `c6` (256 MiB through a stuck watcher, ~15s), the real-time
`protocol::t09`, and the canaries. The timer-bound tests dropped from 5–12s
each to about 1s (`d5` 1.1s, `d6` 1.0s, `d4` 0.8s). `d3` no longer sleeps a
fixed 1.5s per round (15.8s → 1.5s). Both modes are stable with 3–4
concurrent copies of the integration suites.

## Time in tests

The daemon's own timers are the 5s idle grace, the 2s kill grace (stop
reaper and graceful shutdown), the 1s re-adopt poll and the 500ms
leftover-group poll. They go through `src/clock.rs`. In a normal build that
is `tokio::time::sleep`. With the `test-clock` cargo feature **and**
`PBS_TEST_CLOCK=manual` in the daemon's environment, they run on a manual
clock instead:

- Virtual time starts at 0 and moves only on `clock_advance {ms}`.
  `clock_status` lists the pending timers by label (`idle`, `kill-grace`,
  `shutdown-grace`, `adopt-poll`, `group-poll`) and time left.
- Both requests exist only under the feature. They are sent as the first
  frame of a fresh connection, without hello, so they never count as an
  active connection and never cancel the idle timer.
- Everything else stays on real time: child processes, `timeout_ms`, the
  hello timeout, record timestamps.
- The daemon keeps accepting during graceful shutdown (see D8/D8b). That is
  also what lets a test step the 2s grace that holds a shutdown open.

`tests/common` drives it:

- `Home::advance(label, ms)` waits until a timer with that label is armed,
  then advances. A step can never race ahead of the daemon scheduling the
  timer.
- `advance_almost(label, total)` stops 1 ms short and asserts that the timer
  is still pending with exactly 1 ms left. A shorter or longer constant
  fails there, deterministically.
- `advance_past()` takes the last millisecond.
- `advance_now(ms)` shows that a cancelled countdown does not fire.

Without the feature, every step is a real sleep: `advance_almost` sleeps
60% of the timer, and `advance_past` does nothing. So plain `cargo test`
still runs every test against real time, with margins.

`tests/timing_canary.rs` always uses the real clock (`Home::new_real`) and
pins the actual values:

- the idle grace: a task is SIGTERMed 4.9–6.5s after the last client leaves;
- the kill grace: a TERM-ignoring task is SIGKILLed 1.9–3.5s after `stop`.

`protocol::t09` also still runs on real time. Shortening either constant
turns both canaries red. So does the manual-clock suite: 6 lifecycle tests,
including `d7` through the `advance_almost` pending check.

Why not an existing tool:

| Option | Why not |
|---|---|
| tokio `test-util` (`time::pause` / `advance`) | Controls only the runtime of the process under test, and only a current-thread runtime. These tests are black box: the daemon is a separate binary with a multi-thread runtime, and the test cannot reach its runtime. Paused time also auto-advances whenever the runtime is idle. The daemon is idle exactly while it waits on real children, so the 2s kill grace would fire at once, before a TERM-ignoring child could be observed alive. |
| turmoil | Simulates hosts and TCP/UDP inside one process. There are no unix sockets, no `fork`/`exec`, and no signals or process groups. Those are what the lifecycle is made of. |
| madsim | Deterministic simulation, but it replaces tokio and std at build time for the whole crate, and it cannot run real child processes. The kill-grace and group tests need real processes that ignore SIGTERM. |
| Env var that shortens the constants | Faster, but it changes the values under test and still races on the wall clock. A manual clock keeps 5000/2000 exact and makes the ordering deterministic. |

The feature is off by default and adds no dependency. Release builds do not
contain the debug requests (`#[cfg(feature = "test-clock")]` on the protocol
variants). `PBS_TEST_CLOCK` alone does nothing without the feature.

## Lifecycle state-transition table

Columns: **Before** = covered by the tests that existed before this work
(`protocol.rs` + unit tests); **After** = test that now covers the cell.
`FIXED` = the cell was a bug found by this suite; its test failed against
the original code and passes now (see "Bugs found").

### Connection

States: `accepted` (socket open, no hello) → `active(cli|ext)` → `closed`.

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| C1 | accepted | no hello (silent peer) | accepted until 10s, then closed | not counted as active: cannot hold the daemon alive | no | `d7` |
| C2 | accepted | invalid hello (missing session_id / pi_pid, path-like id, v≠1, non-hello first frame) | closed | `E_BAD_REQUEST` / `E_VERSION` response; nothing registered | no | `c2`, `f1` |
| C3 | accepted | valid hello (ext / cli) | active | idle countdown cancelled; ext session registered `connected:true` with its `cwd` | `t01` | `t01`, `d6`, `d16` |
| C4 | active(ext S) | another connection says hello for S | closed | old conn gets `session_rebound`, then server closes it; S's tasks and events follow the new conn | no | `c4` |
| C5 | accepted | hello while shutting down | closed | error response; shutdown not cancelled | no | `d8` |
| C6 | active | peer never reads (slow watcher) | active | its queue caps at 1024 frames; events dropped past that; other clients, the task, and RSS unaffected | no | `c6` |
| C7 | active | frame > 4 MiB (header) | closed | daemon and other conns unaffected; exactly 4 MiB accepted | no | `f1` |
| C8 | active | malformed JSON / second hello | active | `E_BAD_REQUEST`, connection keeps working | no | `f1`, `c2` |
| C9 | active | EOF from a crashed peer (SIGKILL) | closed | session → disconnected, watchers dropped; last conn arms the 5s idle countdown | clean close only (`t09`) | `d5`, `s3` |
| C10 | active | a response would exceed 4 MiB (escaping, huge echoed id) | active | output chunks are cut to fit; any other oversized response becomes `E_INTERNAL`; an unanswerable one is dropped; the connection keeps serving; exactly 4 MiB is delivered | no | **FIXED** `o3`, `o3b`, `o3c`, `g9` |

### Session (extension)

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| S1 | — | ext hello | connected | appears in `status.sessions` with pi_pid and cwd | `t01` | `g5`, `d16` |
| S2 | connected | its connection drops, other clients remain | disconnected | tasks keep running past the 5s grace | no | `s3` |
| S3 | disconnected | hello with the same session_id (`pi --resume`) | connected | sees its tasks; receives their `task_exited` | no | `s3` |
| S4 | connected | duplicate hello | connected (new conn) | see C4 | no | `c4` |
| S5 | connected | `shutdown_session` | connected | exactly its running tasks stopped (`killed`) and reported; leftover groups of its finished tasks killed but not reported; other sessions untouched; cli → `E_SESSION_REQUIRED` | no | `s5`, `t6d` |
| S6 | any | cross-session stop/list/watch | unchanged | `E_FORBIDDEN`, or list silently scoped | list only (`t06`, unit) | `s3`, `g4` |

### Task (§3.4 state machine)

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| T1 | running | exit 0 | completed | persisted with real timestamps; `task_exited` to owning session; `wait` wakes | `t02`, `t04` | `t2` |
| T2 | running | exit ≠ 0 / killed by an outside signal | failed | exit_code, or signal name (`"SIGKILL"`) recorded | unit only | `t2` |
| T3 | running | `timeout_ms` elapses | killed | group SIGKILLed; a task finishing earlier is unaffected | no | `t3` |
| T4 | running | `stop` | killed | SIGTERM to the group first (TERM handlers run) | `t08` (status only) | `t4` |
| T5 | running | `stop`, task ignores SIGTERM | killed after ≥2s | SIGKILL after the grace, not before; `signal:"SIGKILL"` | no | `t5` |
| T6 | running | `stop` with grandchildren | killed | whole process group dies | unit (`signal_group`, not via daemon) | `t6` |
| T6b | running | `stop`, leader dies on SIGTERM, grandchild ignores it | killed | the group is SIGKILLed after the grace even though the leader is gone | no | **FIXED** `t6b` |
| T6c | completed, group lingering | manager shutdown | completed | the leftover group dies with the manager (§3.2) | no | **FIXED** `t6c`, `g11` |
| T6d | completed, group lingering | `stop` / `shutdown_session` | completed | leftover group TERM → 2s → KILL; status unchanged | no | `t6d` |
| T6e | completed, group lingering | last member exits | completed | group no longer tracked: never signalled again, not counted at shutdown | no | `g11` |
| T7 | running (on disk) | manager restart, pid alive | running (re-adopted) | exit polled every 1s; output size recovered from the file | `t12` | `d4`, `g6` |
| T8 | running (on disk) | manager restart, pid dead | orphaned | `ended_at` set, persisted; counted in manager.log | unit only | `d4` |
| T9 | re-adopted | process exits | completed, `exit_code:null` | `task_exited` to the reconnected session; `wait` done | no | `d4` |
| T10 | re-adopted | `stop` | killed | whole group dies | no | `d4b` |
| T11 | running | manager shutdown (idle / `shutdown` / SIGTERM / SIGINT) | killed | persisted as killed; "manager_shutdown" in manager.log | pid-dead only (`t09`) | `d5`, `d9`, `d15`, `g3` |
| T12 | terminal, no group left | `stop` | unchanged | idempotent ok; unknown id → `E_NOT_FOUND` | no | `t12` |
| T13 | terminal (on disk) | manager restart | unchanged | output served from disk, exact bytes; legacy numeric `signal` still loads | no | `t13`, unit |
| T14 | running | `wait` budget expires | running | `done:false` | `t03` | `t03` |
| T15 | any | `task_exited.signal` / `TaskRecord.signal` | — | signal **name** (`"SIGTERM"`/`"SIGKILL"`), null on normal exit | no | **FIXED** `t5b`, unit |
| T16 | any | `output` read / `watch` event over multi-byte text | — | never split a UTF-8 sequence: no U+FFFD for valid text, no skipped bytes; a partial char is held back while the task runs and delivered at EOF | no | **FIXED** `o4`, `o4b`, `o4c`, `g12` |

### Daemon

States: `absent` → `starting` (claim) → `serving` (≥1 active conn) ⇄ `idle`
(0 active conns, 5s countdown) → `shutting_down` → `exited`; `crashed`
(SIGKILL, stale socket/pid left behind).

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| D1 | absent | N clients race to auto-spawn | serving | every client succeeds and is served by the same daemon (its session is in that daemon's `status`); exactly one process holds `manager.lock` (held while it runs, free once it exits); the process count converges to 1 within 2s (a redundant daemon exits "already running" without binding) | no | `d1` |
| D2 | crashed | N clients race over stale files | serving | clients never delete files; exactly one reachable daemon; no client fails | no | **FIXED** `d2` |
| D3 | absent | N `daemon` processes at once (no spawn lock) | 1 survivor | lifetime lock on manager.lock: losers exit 0 "already running" | no | **FIXED** `d3` |
| D4 | crashed | restart | serving | lock holder removes stale files; T7/T8 applied; idle rule still applies to adopted tasks | `t12` | `d4` |
| D5 | serving | last client process SIGKILLed | idle → shutting_down after 5s → exited | nothing touched during the grace; then SIGTERM → 2s → SIGKILL (grandchildren too), records `killed`, socket + pid removed, exit 0 | `t09` (in-process close) | `d5` |
| D6 | idle | hello within 5s | serving | countdown cancelled; restarts from zero when that client leaves | no | `d6`, `d6b` |
| D7 | idle | only a silent (no hello) connection | exited | — | no | `d7` |
| D8 | shutting_down | hello (connection accepted before or during shutdown) | shutting_down | refused at once (`manager is shutting down`); shutdown completes | no | **FIXED** `d8` |
| D8b | shutting_down | CLI command | serving (successor) | the CLI waits for the old manager to exit, then spawns a successor; no stall, no error | no | **FIXED** `d8b` |
| D9 | serving | cli `shutdown` | exited | kills tasks even with an extension still connected; files removed; ext sees EOF | no | `d9` |
| D10 | starting | stale pid (dead) + socket | serving | client path recovers with a new pid | unit, `t12` | `d10` |
| D11 | starting | socket without pid file / corrupt pid file | serving | cleaned by the lock holder | unit | `d11`, `d11b` |
| D11b | idle | clients leave one at a time, the last long after the first | exited | the countdown still runs when the last client leaves | no | `g7` |
| D12 | starting | another daemon holds manager.lock | exits 0 "already running" | nothing touched | `t10` | `t10`, `d3`, unit |
| D13 | starting | pid file names a live unrelated process (pid reuse) | serving | identity is the lock, not the pid | no | **FIXED** `d12` |
| D14 | serving | SIGTERM / SIGINT to the daemon | exited | same graceful path as D5 | no | `d15` |
| D15 | serving | `shutdown` / `status` from an extension | serving | shutdown → `E_FORBIDDEN`; status allowed (read-only), returns the hello `cwd` | no | `d16` |
| D16 | serving | Ctrl-C (SIGINT/SIGHUP) to the process group of the client that spawned it | serving | daemon was detached with setsid | no | `g2` |
| D17 | any | `doctor` | unchanged | no daemon → removes stale files while holding the lock; live daemon → touches nothing, hello ok | no | `g13` |
| D18 | serving | all watched tasks finished | serving | idle: no busy loop | no | `g10` |

**Coverage:** 56 cells (C 10, S 6, T 20, D 20).

| | Covered | Partial | Uncovered | Violated by the code |
|---|---|---|---|---|
| Before (original code, original tests) | 7 | 10 (unit-level, status-only, or in-process close) | 38 | 8 (C10, T6b, T6c, T15, T16, D2, D3, D13) |
| After (fixed code) | 56 | 0 | 0 | 0 |

## Bugs found (all fixed)

Every test below failed against the original code (recorded on the rebased
tree before any src change) and passes now. `t6d`, `o3b`, `o3c`, `o4b` were
added while fixing and were also run against the pre-fix code: all red.

| Bug | Root cause | Fix | Red → green |
|---|---|---|---|
| `t6b` | The stop reaper and the shutdown SIGKILL pass only targeted tasks whose *leader* was still `running`. A leader dying on SIGTERM left SIGTERM-ignoring descendants unkillable. | After the grace, SIGKILL the **process group** whenever it may still have members (`TaskEntry::owns_live_group`). | `t6b` |
| `t6c` | Shutdown only signalled groups of running tasks; a finished task's backgrounded children were never signalled. | At leader exit, `finalize_exit` checks `kill(-pgid,0)`; if members remain the task is marked `group_lingering` and a watcher polls the group every 500ms until it empties (POSIX never reuses a pid while its group exists). Shutdown, `stop` and `shutdown_session` all include lingering groups. | `t6c`, `t6d`, `g11` |
| `d2` | Client §3.1 step 5 read a stale pid file, then deleted socket + pid — possibly those of a daemon another client had just spawned. | Clients never delete socket/pid files. Only the daemon holding `manager.lock` cleans up. | `d2` |
| `d3` | `claim_pid` was check-then-act: a daemon's socket, bound before its pid file was written, looked like a zombie to a concurrent daemon, which unlinked it. | The daemon takes an exclusive flock on `manager.lock` (O_CLOEXEC, so tasks never inherit it) and holds it for its lifetime. The holder is the only daemon, so any socket/pid it finds is stale. | `d3`, unit `claim_is_exclusive_and_ignores_pid_liveness` |
| `d12` | Identity was `kill(pid,0)` on manager.pid; a reused pid blocked startup forever. | Same lock: identity is the lock, the pid file is informational. `doctor` also uses the lock and cleans only while holding it. | `d12`, `g13` |
| `o3` | Reads were capped at 1 MiB of raw bytes, but control bytes JSON-escape to 6 bytes: the >4 MiB response made `write_frame` fail and the writer task exit, and the connection went mute. | `utf8_chunk_len` cuts each chunk so its escaped size fits `CHUNK_JSON_BUDGET` (4 MiB − 64 KiB). `respond` turns any other oversized response into `E_INTERNAL`; the writer drops an unsendable frame instead of exiting. | `o3`, `o3b`, `o3c`, `g9` |
| `o4` | Chunks were lossy-decoded per read; a `max_bytes` or pipe boundary inside a multi-byte char produced U+FFFD while `next_cursor` skipped the bytes. | Reads fetch `cap + 3` bytes and cut at the last char boundary (a first char wider than `max_bytes` is sent whole, so reads always progress). A truncated tail is held back while the task runs. Watch events carry an incomplete tail over to the next pipe read and flush it at EOF. | `o4`, `o4b`, `o4c`, `g12`, unit `chunk_len_*` |
| `d8b` | Once shutdown began, the accept loop was gone but the socket stayed bound: a client connecting in that window waited for its 30s response timeout, then failed (was deferred in part A). | The daemon keeps accepting during shutdown and refuses hello at once; a client refused with `manager is shutting down` waits (≤ 5s) for that manager's pid to exit, then spawns a successor. | `d8` (fresh connection), `d8b` |
| `t13` flake | `finalize_exit` persisted `output_size` at child exit, before the tee had drained the pipe. After a restart the loaded record reported too few bytes (0 under load; seen once in a stress run as `t13` `total_size` 0 vs 13893). | `scan_tasks` takes `max(record, file length)` for every loaded record, not only re-adopted ones: the file is append-only and can no longer grow. | unit `scan_recovers_output_size_of_terminal_records_from_the_file` |
| `d11` flake (test harness) | The test made its "dead" socket with `UnixListener::bind` + `drop` inside the multi-threaded test binary. On macOS, std sets FD_CLOEXEC only after `socket()` returns, so a child spawned by another test thread in that window inherits the socket and keeps it listening after the drop. `ls` then connected, got no hello answer, and hit the 10s test timeout. A standalone repro under heavy concurrent spawning: 833 of 3000 dropped listeners still accepted connections. Keeping the listener open in d11 reproduces the exact failure (`cli ["ls"] did not finish within 10s`). Not product behaviour: the daemon binds its listener before it spawns any task, and a task inherits only fds 0–2 (checked by listing `/dev/fd` from a task). | `common::dead_socket` checks that a connect is refused and otherwise retries on a fresh inode (0 of 3000 left live in the same repro). Used by `d11` and `g13`. | `d11`; full suite 5× × 3 copies: plain 15/15, test-clock 15/15 |
| `e1` flake (events.jsonl order) | `finalize_exit` published a task's terminal status under the state lock but wrote its `task.exit` line after unlocking. A client that saw the task finish (`list` served by another worker) and then disconnected could get `session.disconnect` into the file first (seen once in the 10×3 stress run: disconnect at …372 ahead of exit at …371). A reader of events.jsonl right after a finished `wait`/`list` could also miss the line. `task.start` was written after the exit watcher was spawned, and `task.background` after unlocking, so both could land after a fast `task.exit`. | Every task event line is written under the state lock, before the state it records becomes visible: `task.start` before the task is inserted, `task.exit` before `status_tx` fires (also in the shutdown force-finalize pass), `task.background` together with `backgrounded_at`. | `e5` (100 fast tasks, `list` from a second connection, then read the file). Red-first needed a 50 ms sleep in the old unlocked window (`round 0: … task.exit is not written yet`); after the fix it stayed green with the same sleep in place. |
| `e4` hang (`events -f` gap) | `events -f` printed history, *then* took every file's length as its follow offset. A line appended in between was skipped for good. `e4` appends to a new session the moment history is out; in one stress run the follower missed it, and the test's unbounded `read_line` blocked for hours until the follower was killed. | History reading returns, per file, the offset just past the last complete line it consumed, and following continues from exactly there (no gap, no duplicates). `e4` reads through a channel with a 5s bound, so a miss fails instead of hanging. | `e4`. Red-first: with a 300 ms sleep in the old window, `events -f never printed the line appended right after its history`; green with the same sleep after the fix. |
| `d6b` flake (manual-clock helper) | `Home::advance` waited for "any timer with that label". Cancelling the idle countdown is an async `abort()`, so under load the aborted timer was still listed, and the helper stepped 4,999 ms before the daemon had armed the new countdown (`pending: [idle due 0]` at t=6999). | `advance(label, ms)` waits for a `label` timer with at least `ms` left; `advance_almost(label, total)` for one with exactly `total` left (freshly armed). A leftover never has that much left, because the clock has moved since it was armed. A shortened constant still fails deterministically. | test-clock 5×3 stress: 14/15 before, 15/15 after |
| `t14` (descriptor leak into tasks) | Tasks inherited every daemon fd that lacked close-on-exec. On macOS, std sets FD_CLOEXEC only after `accept()` returns, so a task forked in that window got a copy of a client connection. That client then saw no EOF when the daemon closed it (session rebind, shutdown) until the task exited. The same happened to anything the daemon itself inherited without the flag. Found while root-causing `d11`. | The `pre_exec` hook that runs `setsid` now marks every fd ≥ 3 close-on-exec: `close_range(3, ~0, CLOSE_RANGE_CLOEXEC)` on Linux ≥ 5.11, otherwise an `fcntl` loop up to a bound computed before fork: the highest fd open in `/dev/fd` plus 64 slack, never above the soft RLIMIT_NOFILE. The limit alone is often 10^6, and even capped at 65536 it cost every spawn ~65k syscalls. That load made two existing `task.rs` unit-test races show up (next row). Nothing in the hook allocates. The fds are marked rather than closed, because std reports exec failures over a close-on-exec pipe that must stay open until exec. Applies to tasks and to the daemon the CLI spawns. | `t14` (the daemon holds an inherited fd 20 and two client connections; the task lists its own fds): red before (`"fd 20\nend\n"`), green after. `s6` (40 session rebinds while 120 tasks spawn; each old connection must see EOF within 2s) guards the behaviour; its pre-fix red is only statistical (a microsecond window), so it passed before the fix too. |
| `task.rs` unit-test races (macOS) | Found while verifying the fd fix in a clean copy, 1 run in 300. `spawn_captures_merged_output_and_exit` called `getpgid` on a task that had usually already exited; on macOS a finished process is already gone for `getpgid`. `signal_group_kills_whole_tree` required `Ok` from signalling a dead group, but while the reparented grandchild is still an unreaped zombie, macOS answers EPERM, not ESRCH. Callers ignore that result either way. | The task reports its own process group (`ps -o pgid= -p $$`); the dead-group call accepts EPERM. The test-only `sys::getpgid` is removed. | full unit harness 300× in a loop: 0 failures |
| `d1` flake (process-count snapshot) | `d1` counted daemon processes once, right after the 12 clients returned, and required exactly one. It failed twice (under mutation load in part A, and once in a clean-copy test-clock run), and the diagnostics were lost both times. A client that loses the race can spawn a redundant daemon, which exits "already running" without binding; a snapshot can catch it before it exits. The count was also standing in for the invariant: the old test never checked that the clients were served by that daemon. | Nothing in the product: the lifetime lock already guarantees one serving daemon. `d1` now asserts the invariant itself. (a) Each client opens its own session with `start --session`, and all 12 must appear in the survivor's `status` (sessions live only in the memory of the daemon that served them). (b) `manager.lock` is held while the socket's daemon runs, and free the moment it exits. (c) The process count converges to 1 within 2s. Failures print `ps -ww` lines and manager.log. | `d1` 100 rounds × 3 parallel copies in each mode: plain 300/300, test-clock 300/300. Proof it can fail: the `daemon-lifetime-lock` ablation turns it red at (b) (`nobody holds manager.lock`); expecting one session no client opened turns (a) red. |
| `t5b` | `signal` was an integer on the wire and on disk; §3.3 and the extension type say `"SIGTERM"`/`"SIGKILL"`. | `signal` is a name (`proto::signal_name`) in `task_exited`, `TaskRecord` and the CLI `EXIT` column (widened to 7). Legacy numeric records still load (converted). The extension only tests truthiness / displays it; verified with `tsc`, its unit tests, and its real-binary integration tests. | `t5b`, `t2`, unit `signal_names_on_wire_and_legacy_numbers_load` |

## Observability contract (manager + CLI side)

`tests/observability.rs` covers the contract black-box. Extension-owned
files (agent records, transcripts, extension events) are written as
fixtures in the contract's format, because the extension side may land later.

| Requirement | Test |
|---|---|
| `start.origin` stored; `mark_background` → `backgrounded_at` (first time kept, persisted) | `p1` |
| `stop.reason` → `end_reason` (`stopped:tui/cli/tool`, `timeout`, `rate-limit`, `session-end`; none = `stopped:tool`; unknown → `E_BAD_REQUEST`); natural exit → `exited`; `timeout_ms` → `timeout`; `shutdown_session` → `session-end`; first reason wins; `task_exited.end_reason` | `p1` |
| `manager-shutdown`, `orphaned`, `manager-restart` | `p2` |
| hello `extension_version`/`protocol` stored per session; `status.protocol`; `connected_at` kept across reconnects; `last_seen` | `p3` |
| manager writes `session.connect/disconnect`, `task.start` (command ≤ 200 chars, origin, pid), `task.background`, `task.stop`, `task.exit`, `daemon.start/shutdown` | `e1` |
| a task event line is on disk before anyone can see the state it records, in causal order (`task.start` < `task.exit`) | `e5` |
| every line < 4 KiB, oversized fields truncated (`truncated:true`), ids never cut | `e2`, unit `events::*` |
| concurrent appends (8 extension-style writers × 300 lines of 1–3.5 KiB, plus the manager) never interleave or lose lines | `e3` |
| `events`: malformed lines skipped with a stderr count; `--id` matches `id`/`ids[]`/`child_id`; `--session`, `--since`, `--json`, `-f` (incl. new sessions); cross-session time order; never starts the daemon | `e4` |
| `ls`: columns, running-only default, `-a`, agents included, SESSION shortest unique prefix ≥ 8, CJK display-width truncation, `--json`, `--session`/`--cwd`/`--since`, bad duration rejected | `c1`, unit `fmt::*`, `inspect::*` |
| `show` for sh_/ch_/run_ (header, origin, backgrounded, wake emitted→delivered, last 10 lines; agent error/tool calls/shells/prompt/result tail 20), fuzzy + `--json`, one-line not-found with closest match | `c2` |
| `agent` (preamble hidden, `--full`), `log`/`tail -f` on ch_ ids, `output`/`wait` on ch_, `stop` on an agent refused with the contract message | `c3` |
| `stop` → `stopped:cli`; "already finished (<reason>)" | `c4` |
| `sessions` / `-a` (gone sessions from events.jsonl, counts, `--json`), no spawn | `c5` |
| `status`: human uptime, counts incl. agents, protocol, `--json`; not running → exit 1, no spawn | `c6` |
| `output --max-bytes` is a total cap (UTF-8 safe); SIGPIPE → exit 0, silent (output, ls, events, log); human timestamps in `log` | `c7` |
| `doctor`: home missing (not created), config.json, managerPath, stale agent records, orphan pids, socket path length, exit status; protocol per session | `c8`, `protocol::t11`, `mutation_gaps::g13` |

Interpretation decisions where the contract is silent (also in design §3.3
and docs/cli.md): `PROTOCOL = 2`; a stop without `reason` ends as
`stopped:tool`; `shutdown_session` maps to `session-end`; a re-adopted
task whose exit is only seen after a restart ends as `manager-restart`;
`daemon.*` events go to `<home>/events.jsonl`; doctor counts stale
socket/pid files it removed as `fixed` (exit 0), not failures;
`status`, `sessions`, `show`, `agent`, `events`, `log`/`tail` and
`shutdown` never start the daemon.

## Mutation score

`cargo mutants 27.1.0`. A timeout is an infinite loop the tests detect by
hanging, so it counts as killed; score = (caught + timeout) / viable.

History (five files `lifecycle task registry daemon sys`, old code):

| Run | Viable | Killed | Missed | Score |
|---|---|---|---|---|
| Original tests only | 191 | 129 | 62 | 67.5% |
| + lifecycle_adversarial + g1–g8 | 191 | 170 | 21 | 89.0% |

Fixed code, six files (`proto.rs` added: it holds the frame codec and
signal names). The full run was made first, then the survivors drove
g9–g13, o4c, and unit tests for `utf8_chunk_len`, `signal_name` and
`new_request_id`. Two `--iterate` passes re-tested every survivor
(line-shifted mutants of edited code were re-tested too and caught again):

| File | Viable | Full run: killed / missed | After survivor tests: killed / missed | Score |
|---|---|---|---|---|
| daemon.rs | 116 | 95 / 21 | 112 / 4 | 96.6% |
| lifecycle.rs | 33 | 25 / 8 | 29 / 4 | 87.9% |
| proto.rs | 72 | 37 / 35 | 59 / 13 | 81.9% |
| registry.rs | 19 | 18 / 1 | 19 / 0 | 100% |
| sys.rs | 22 | 18 / 4 | 20 / 2 | 90.9% |
| task.rs | 82 | 77 / 5 | 81 / 1 | 98.8% |
| **total** | **344** | **270 / 74 (78.5%)** | **320 / 24** | **93.0%** |

`client.rs` (the touched functions `connect`, `cmd_doctor`, `cmd_list`,
`ls_header`, `format_ls_row`): 34 mutants, 2 unviable, 32 viable, 25
killed, 7 missed (78.1%). All 12 `cmd_doctor` mutants are killed (`g13`).

The 24 manager survivors and 7 client survivors, classified as (a) missing
test, (b) equivalent (no observable difference under the contract), (c)
dead or unneeded code:

| Mutant | Class | Why |
|---|---|---|
| daemon.rs:422:44, 430:36 idle-timer guards | b | The two guards duplicate each other, and every disconnect re-arms anyway (the sibling guard was a real gap, killed by `g7`). |
| daemon.rs:531:20 access_for guard → true | b | Differs only for a cli hello carrying a session_id, which no client sends. |
| daemon.rs:739:40 ring `avail` `-`→`+` | b | `slice()` clamps to the ring; the ring is a pure cache of `.output` (`g1` checks bytes exactly). |
| lifecycle.rs:93:23, 138:19, 176:19, 203:19 NotFound / WouldBlock guards → true | b | Only other io errors (read-only home, EACCES on a lock) differ, and only in the error message; startup fails either way. |
| proto.rs:387:19 UnexpectedEof guard → true | b | The daemon treats EOF and read errors identically (close the connection); the CLI only changes an error message. |
| proto.rs:446:26 `\|`→`^` on the variant byte | b | `& 0x3f` already cleared bit 7, so `^ 0x80` equals `\| 0x80`. |
| proto.rs:433–437 ×11 in `random_bytes` fallback | **c** | The fallback PRNG runs only when `/dev/urandom` cannot be read, which does not happen on the supported unix targets. **Slop candidate** (not on the approved removal list, so kept). |
| sys.rs:28:34, 42:34 `setsid() == -1` → `== 1` | b | `setsid` cannot fail in a freshly forked non-leader child and never returns 1. |
| task.rs:22:37 RING_CAPACITY `64*1024`→`64+1024` | b | Ring is cache-only; a smaller ring only changes performance. No black-box test can tell the ring exists. |
| client.rs:149:20 `attempt > 0` → `<` in `connect` | b | Only changes the error path after two failed attempts (one extra spawn try before erroring). |
| client.rs:161:20, 167:20 delete `!` in `connect` | b | Only changes which error text is kept; a successful spawn is still found on the retry. |
| client.rs:239:40 ×2, 242:28 ×2 in `cmd_list` | a (not this work) | The "N terminal hidden, use -a" hint arithmetic from the KIND/agent-records change. Untested, but not code touched here. |

### Observability and test-clock code (parts B and C)

`cargo mutants --features test-clock --in-diff` over every `src` change
since the part-A docs commit (`6ec4135..`): 493 mutants, 35 unviable,
**458 viable, 330 caught + 12 timeouts = 74.7%**. The run took 68 min at
`-j 4`. `clock.rs`: all 15 viable mutants killed.

The two manager survivors were followed up:

- `daemon.rs` `touch_session` → `()`: **dead code, removed**. `status`
  reports `now` as `last_seen` for a connected session, and disconnect
  sets `last_seen` itself, so the per-request update could never be seen.
- `daemon.rs` `delete !` in `spawn_adopted_poller`: **missing test**. The
  poller then stops sleeping after its first tick and spins. `g14` (daemon
  CPU with one re-adopted task) now kills it. It first survived `g14`
  because the manual clock never passed the first `adopt-poll` tick; the
  test now advances it.

After those: 343 / 457 = **75.1%**. The other 114 survivors are all in the
CLI presentation code. Classes: (a) missing test, (b) equivalent or not
observable in tests, (c) dead.

| Area | Survivors | Class | What |
|---|---|---|---|
| `fmt.rs` `char_width` ranges | 11 | a | Only a few CJK and emoji ranges are exercised. `\|\|`→`&&` on the others goes unseen. |
| `fmt.rs` `human_duration`, `datetime`, `short_time`, `local` | 10 | a / b | Boundary values (exactly 60s, 60m, 24h) are untested (a). Human timestamps are only checked for shape, not value (a). The tz offset arithmetic is equivalent on a UTC-offset-0 check (b). |
| `events.rs` `encode_line`, `shrink_longest_string` | 18 | a | Truncation arithmetic at the edges of the 4 KiB cap. The tests assert that every line is under the cap and still valid JSON, not the exact size removed. Some `<`/`<=` swaps sit exactly on the cap (b). |
| `sys.rs` `stdout_tty_columns`, `inspect.rs` `term_width` | 12 | b | The tests never run on a TTY, so terminal width is always unknown. |
| `inspect.rs` `cmd_ls`, `render_ls`, `session_views` | 16 | a | The "N hidden, use -a" hint counts, session sort order for equal timestamps, and the COMMAND width arithmetic. |
| `inspect.rs` transcripts, `wake_summary`, `cmd_show`, `render_event`, `cmd_events`, `cmd_sessions`, `cmd_status`, `wait_agent` | 19 | a | Rendering details (preamble detection edges, tail windows, `-f` poll bookkeeping), and the `wait` budget arithmetic for agents. |
| `client.rs` `cmd_doctor`, `dir_size`, `Report::warn` | 16 | a | The doctor's disk-usage line and warnings are printed but not asserted. The protocol-match branch is only tested as a mismatch. |
| `client.rs` `resolve_task_id` closest match | 6 | a | The distance thresholds of the "did you mean" hint. |
| `client.rs` `cmd_kill_session`, `cmd_start` → `Ok(())` | 2 | a | Convenience commands without black-box tests. |
| `client.rs` `wait_for_manager_exit` | 2 | b | `&&`→`\|\|` always waits the full 5s and `<`→`<=` changes nothing. Only latency differs, and `d8b` still passes. |
| `client.rs` `cmd_output` | 1 | a | The `--max-bytes` read-size clamp. |
| `out.rs` `bytes` | 1 | b | The EPIPE check vs. other write errors; both end the command. |

deferred: tests for the (a) rows above | impact: CLI rendering regressions (widths, hints, doctor text) would not be caught; no effect on the lifecycle or wire contract | trigger: the first user-visible CLI rendering bug, or before the CLI output is declared stable for scripts

## Changed code for the fixes

| File | Change |
|---|---|
| `src/lifecycle.rs` | `claim_pid` → `claim_daemon` (lifetime flock on `manager.lock`); `clean_if_no_daemon` for doctor; `daemon_lock_path`; re-adopt recovers `output_size` from the file |
| `src/daemon.rs` | holds the daemon lock for its lifetime; process-group lifetime (`owns_live_group`, `spawn_group_watcher`, group SIGKILL in reaper/shutdown/shutdown_session/stop); UTF-8 + escaped-size chunking in `handle_output` and the watch fanout; oversize response → `E_INTERNAL`; writer skips unsendable frames; signal names; adopted poller reduced to the exit poll |
| `src/task.rs` | `utf8_chunk_len`, `json_escaped_len`, `UTF8_LOOKAHEAD`; `read_file_range` via `take().read_to_end`; EINTR arm removed |
| `src/proto.rs` | `signal: Option<String>` with legacy-number deserializer; `signal_name` |
| `src/registry.rs` | `group_lingering`, `owns_live_group` |
| `src/sys.rs` | `group_alive` |
| `src/client.rs` | no client-side file cleanup; doctor uses the daemon lock; EXIT column shows signal names (width 7) |
| `docs/design.md` | §3.1 singleton via `manager.lock`, clients never clean; §3.2 group kill incl. lingering groups; §3.3 signal names, chunk boundary and frame-size rules; §3.4 re-adopt output size |
| `docs/cli.md` | layout (`manager.lock` vs `manager.spawn.lock`), EXIT column, doctor |

## Ablation

`ablation.toml` lists 45 load-bearing mechanisms (32 lifecycle, 13
observability), each with a literal
find/replace and the tests that must go red. `scripts/ablate.sh` applies
each one to a scratch copy (sharing one build cache), first checks that
every listed test passes on the pristine copy (a test that is already red
proves nothing), then runs them one by one and compares the result with
`expect`. Per-test logs go to `$ABLATE_WORK/logs/`. Needs `cargo`,
`python3` ≥ 3.11 (tomllib), `perl`, `rsync`. The runner builds and
tests with `--features test-clock` unless `ABLATE_FEATURES` is set (empty =
real time). The full run takes 476s with the manual clock, against about
20 minutes on real time.

**Runner bug found and fixed (`fix(ablate)` commit).** `fresh_copy` used
`rsync -a`, which restores a file changed by an earlier ablation with the
pristine file's *older* mtime, so cargo kept the ablated binary. Within one
run every ablation edits a file and forces a rebuild, so verdicts were
sound; but a later run's **baseline** could test the previous run's last
ablated binary. That was the one unexplained `c6` baseline failure seen
during part A (the previous run ended on a bounded-queue ablation), which
had been filed as a possible flake. Restores now rewrite differing files
with a new mtime.

Final pass (manual clock, after the test-clock work): **44/44 entries
behave as declared** (43 red, 1 green), with no baseline flakes. The first
run reported `refuse-hello-while-shutting-down` as a stale manifest (see
below); after that fix it was re-run and is red.

| Ablation (mechanism removed) | Tests red |
|---|---|
| idle-grace-5s (5s → 50ms) | 4/4: d5, d6, d6b, t09 |
| idle-shutdown-fires | 4/4: d5, d7, d4, t09 |
| idle-timer-cancel-on-hello | 1/1: d6b |
| sigkill-grace-2s (2s → 0) | 1/1: t5 |
| stop-sigkill-escalation (group SIGKILL after grace) | 2/2: t5, t6b |
| lingering-group-tracking | 3/3: t6b, t6c, t6d |
| shutdown-sigkill-escalation | 3/3: d5, d9, d8 |
| setsid-process-group (tasks) | 4/4: t6, t5, d5, d4 |
| group-signal (kill(-pgid) → kill(pid)) | 3/3: t6, d5, d4b |
| bounded-conn-queue (1024 → 2^28) | 1/1: c6 |
| bounded-tee-channel (64 → 2^28) | 1/1: c6 |
| daemon-lifetime-lock (guard dropped at startup) | 3/3: t10, d3, d1 |
| claim-removes-stale-files | 3/3: d10, d4, t12 |
| clients-never-clean (re-adds the old client cleanup) | 1/1: d2 |
| spawn-lock | 0/2 (declared green, see below) |
| utf8-chunk-boundary | 2/2: o4, o3 |
| escaped-size-budget | 1/1: o3 |
| watch-utf8-carry | 1/1: o4b |
| oversize-response-fallback | 1/1: o3b |
| writer-skips-oversize | 1/1: o3c |
| readopt-liveness | 2/2: d4, t12 |
| orphan-dead-pids | 1/1: d4 |
| adopted-exit-poller | 1/1: d4 |
| session-rebound-close | 1/1: c4 |
| refuse-hello-while-shutting-down | 1/1: d8 |
| cleanup-files-on-shutdown | 3/3: d5, d9, d15 |
| frame-size-limit | 1/1: f1 |
| timeout-hard-kill | 1/1: t3 |
| daemon-detach-setsid (auto-spawned daemon) | 1/1: g2 |
| accept-during-shutdown (accept loop stops at shutdown, as before) | 2/2: d8, d8b |
| client-waits-out-shutdown | 1/1: d8b |
| child-fd-hygiene (fd scan disabled; macOS path) | 1/1: t14 |

Changes from the first manifest:

- **pidfile-liveness-daemon / pidfile-liveness-client** are gone with the
  mechanisms themselves. They are replaced by **daemon-lifetime-lock**,
  **claim-removes-stale-files** and **clients-never-clean**. The last is a
  regression check: re-adding the deleted client-side cleanup turns `d2` red.
- **spawn-lock** is now `green` by design. The daemon lifetime lock alone
  guarantees a single daemon (`d1` and `d2` stay green without the spawn
  lock); the spawn lock only avoids starting redundant processes that then
  exit "already running". It is kept as a cheap optimisation, not for
  correctness.
- **refuse-hello-while-shutting-down** first stayed green: once shutdown
  starts, the accept loop has exited, so only a connection accepted
  *before* shutdown can race it. `d8` now opens its connection first.
- **refuse-hello-while-shutting-down** now finds `SHUTTING_DOWN` (the
  message became a shared constant, so the client can recognise it).
- Under the manual clock, **idle-grace-5s** and **sigkill-grace-2s** go red
  through the clock helpers, not by timing: `advance_almost` finds no
  pending timer 1 ms short of 5000 (`d5`), or the timer never shows up as
  armed (`d6b`; `t5` with a zero grace). `protocol::t09` still catches the
  idle case on real time. The canaries pin the real values.
- **bounded-tee-channel** was first declared `green` ("fanout never
  blocks"), which was wrong: the fanout lags the tee at high output rates,
  and without the bound RSS grew ~190 MiB for 256 MiB of output.

## Removed code (slop)

| Removed | Why it was safe | Check |
|---|---|---|
| Output tailing + watch fanout in `spawn_adopted_poller` | Unreachable. The task's stdout pipe dies with the old manager, so the file cannot grow after restart. The one useful effect (recovering `output_size`) moved into `scan_tasks` as a `metadata().len()` read. | `g6` (pre-crash output size and bytes after restart), `d4`, `d4b` stay green |
| `Interrupted` retry arm in `pump_async` | tokio's `AsyncRead` retries EINTR internally and never surfaces it | full suite green |
| Hand-rolled read loop + `Interrupted` arm in `read_file_range` | Replaced by `take(max).read_to_end`, which retries EINTR itself | `read_file_range_offsets`, `g1`, `g8`, `o1`, `t13` green |
| Client-side zombie cleanup in `connect` (§3.1 step 5) | Redundant with the daemon's cleanup, and the cause of bug d2 | `d2`, `d10`, `d11`, `d11b` green; ablation `clients-never-clean` |
| `claim_pid` (pid-liveness identity) | Replaced by the lifetime lock | `t10`, `d3`, `d12` |
| `touch_session` (per-request `last_seen` update, part B) | Unobservable: `status` reports `now` for connected sessions and disconnect sets `last_seen` | `p3`, `c5` green; found as a mutation survivor |

No removal turned a test red.

## Deferrals

- deferred: HELLO_TIMEOUT (10s) close of a silent connection is not asserted, only that it does not keep the daemon alive | impact: a silent peer holds one fd for 10s; not customer-visible | trigger: if connection limits are added
- deferred: Windows named-pipe path (design §3.1) has no tests; `sys.rs` is unix-only | impact: none until Windows ships | trigger: first Windows build
- deferred: the extension's own connect path (TypeScript) is not changed to wait out a shutting-down manager the way the Rust client now does; the exact protocol to implement is design §3.1 step 6 | impact: an extension connecting in the ≤ 2s shutdown window gets `manager is shutting down` at once instead of a successor | trigger: extension side of this branch's merge (handed to the extension engineer)
- deferred: `task_exited.output_size` (live event) is the size at child exit and can be short by what was still in the pipe; the in-memory record catches up and a restart recovers it from the file | impact: the extension's byte count hint can be low for a fast-exiting, high-output task; reads still return every byte | trigger: any consumer that uses `output_size` as a read bound
- deferred: re-adopted tasks are identified by pid liveness only (`kill(pid,0)`); a task pid reused while no manager ran would be re-adopted, and signalled on stop/shutdown | impact: wrong process signalled after a crash plus a long gap | trigger: persisting process start time in TaskRecord (a contract change)
