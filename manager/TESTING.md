# pbs-manager testing

How the manager is tested, what the tests are known to guard, and where the
gaps are. Contract sources: `docs/design.md` §3 and `docs/cli.md`.

## Suites

| Suite | Kind | What it covers |
|---|---|---|
| `src/**` `#[cfg(test)]` | unit | ring buffer, record persistence, state mapping, claim_pid, id format |
| `tests/protocol.rs` | black box | message round-trips, basic lifecycle (t01–t13) |
| `tests/lifecycle_adversarial.rs` | black box | every cell of the lifecycle table below, adversarial conditions |
| `tests/mutation_gaps.rs` | black box | behaviours found unguarded by cargo-mutants survivors |
| `tests/common/mod.rs` | helpers | wire client, isolated `--home`, process probes, crashable helper client |

All black-box tests start the compiled binary with an isolated `--home`
(`$TMPDIR/pbsx-<pid>-<test>`, kept short for the ~104-byte socket path
limit) and speak the u32-BE + JSON protocol directly. They depend only on
`serde_json` and `libc`, which are already regular dependencies, so there
are **no new dev-dependencies**.

Determinism rules:

- Every wait is a poll with a deadline (`poll_until`). Fixed sleeps appear
  only where elapsed time is the thing under test ("nothing may be killed
  during the 5s grace"), and they sit well inside the tolerance.
- A crashing pi is a real separate OS process: the test binary re-executes
  itself as `helper_hold_extension_conn` (an ignored no-op test when run
  normally), which connects, starts tasks, and is then SIGKILLed.
- Cleanup: each `Home` kills every recorded task process group and the
  daemon on drop, even when the test panics.

```bash
cd manager
cargo test                                               # everything (~40s wall, warm build)
cargo test --test lifecycle_adversarial                  # adversarial suite
cargo test --test lifecycle_adversarial -- --ignored --skip helper_   # known-bug reproducers (all FAIL)
cargo mutants -j 3 --timeout 150 -f src/lifecycle.rs -f src/task.rs \
  -f src/registry.rs -f src/daemon.rs -f src/sys.rs      # mutation score (~20 min)
```

Most of the wall time goes to the contract's own timers (5s idle grace,
2s kill grace); tests inside a binary run in parallel.

## Lifecycle state-transition table

Columns: **Before** = covered by the tests that existed before this work
(`protocol.rs` + unit tests); **After** = test that now covers the cell.
`BUG` = the invariant is violated today; the test is `#[ignore = "bug: …"]`
and fails when run.

### Connection

States: `accepted` (socket open, no hello) → `active(cli|ext)` → `closed`.

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| C1 | accepted | no hello (silent peer) | accepted until 10s, then closed | not counted as active: cannot hold the daemon alive | no | `d7` |
| C2 | accepted | invalid hello (missing session_id / pi_pid, path-like id, v≠1, non-hello first frame) | closed | `E_BAD_REQUEST` / `E_VERSION` response; nothing registered | no | `c2`, `f1` |
| C3 | accepted | valid hello (ext / cli) | active | idle countdown cancelled; ext session registered `connected:true` | `t01` | `t01`, `d6` |
| C4 | active(ext S) | another connection says hello for S | closed | old conn gets `session_rebound`, then server closes it; S's tasks and events follow the new conn | no | `c4` |
| C5 | accepted | hello while shutting down | closed | error response; shutdown not cancelled | no | `d8` |
| C6 | active | peer never reads (slow watcher) | active | its queue caps at 1024 frames; events dropped past that; other clients, the task, and RSS unaffected | no | `c6` |
| C7 | active | frame > 4 MiB (header) | closed | daemon and other conns unaffected; exactly 4 MiB accepted | no | `f1` |
| C8 | active | malformed JSON / second hello | active | `E_BAD_REQUEST`, connection keeps working | no | `f1`, `c2` |
| C9 | active | EOF from a crashed peer (SIGKILL) | closed | session → disconnected, watchers dropped; last conn arms the 5s idle countdown | clean close only (`t09`) | `d5`, `s3` |
| C10 | active | response larger than 4 MiB after JSON escaping | **mute**: writer task exits, requests get no reply | (should be: error response or bounded chunk) | no | **BUG** `o3` |

### Session (extension)

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| S1 | — | ext hello | connected | appears in `status.sessions` with pi_pid | `t01` | `g5` |
| S2 | connected | its connection drops, other clients remain | disconnected | tasks keep running past the 5s grace | no | `s3` |
| S3 | disconnected | hello with the same session_id (`pi --resume`) | connected | sees its tasks; receives their `task_exited` | no | `s3` |
| S4 | connected | duplicate hello | connected (new conn) | see C4 | no | `c4` |
| S5 | connected | `shutdown_session` | connected | exactly its running tasks stopped (`killed`); other sessions untouched; cli → `E_SESSION_REQUIRED` | no | `s5` |
| S6 | any | cross-session stop/list/watch | unchanged | `E_FORBIDDEN`, or list silently scoped | list only (`t06`, unit) | `s3`, `g4` |

### Task (§3.4 state machine)

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| T1 | running | exit 0 | completed | persisted; `task_exited` to owning session; `wait` wakes | `t02`, `t04` | `t2` |
| T2 | running | exit ≠ 0 / killed by an outside signal | failed | exit_code or signal recorded | unit only | `t2` |
| T3 | running | `timeout_ms` elapses | killed | group SIGKILLed; a task finishing earlier is unaffected | no | `t3` |
| T4 | running | `stop` | killed | SIGTERM to the group first (TERM handlers run) | `t08` (status only) | `t4` |
| T5 | running | `stop`, task ignores SIGTERM | killed after ≥2s | SIGKILL after the grace, not before | no | `t5` |
| T6 | running | `stop` with grandchildren | killed | whole process group dies | unit (`signal_group`, not via daemon) | `t6` |
| T6b | running | `stop`, leader dies on SIGTERM, grandchild ignores it | killed | grandchild must be SIGKILLed after grace — **it survives forever** | no | **BUG** `t6b` |
| T6c | completed | manager shutdown while the task's background child still runs | completed | child must die with the manager (§3.2) — **it survives** | no | **BUG** `t6c` |
| T7 | running (on disk) | manager restart, pid alive | running (re-adopted) | exit polled every 1s; pre-crash output size recovered | `t12` | `d4`, `g6` |
| T8 | running (on disk) | manager restart, pid dead | orphaned | `ended_at` set, persisted | unit only | `d4` |
| T9 | re-adopted | process exits | completed, `exit_code:null` | `task_exited` to the reconnected session; `wait` done | no | `d4` |
| T10 | re-adopted | `stop` | killed | whole group dies | no | `d4b` |
| T11 | running | manager shutdown (idle / `shutdown` / SIGTERM / SIGINT) | killed | persisted as killed; "manager_shutdown" in manager.log | pid-dead only (`t09`) | `d5`, `d9`, `d15`, `g3` |
| T12 | terminal | `stop` | unchanged | idempotent ok; unknown id → `E_NOT_FOUND` | no | `t12` |
| T13 | terminal (on disk) | manager restart | unchanged | output served from disk, exact bytes | no | `t13` |
| T14 | running | `wait` budget expires | running | `done:false` | `t03` | `t03` |
| T15 | any | `task_exited.signal` | — | contract §3.3 says `"SIGTERM"`/`"SIGKILL"`, wire sends 15 / 9 | no | **BUG** `t5b` |

### Daemon

States: `absent` → `starting` (claim) → `serving` (≥1 active conn) ⇄ `idle`
(0 active conns, 5s countdown) → `shutting_down` → `exited`; `crashed`
(SIGKILL, stale socket/pid left behind).

| # | State | Event | Next state | Side effects | Before | After |
|---|---|---|---|---|---|---|
| D1 | absent | N clients race to auto-spawn | serving | spawn lock serializes; every client succeeds and reaches the same pid. (An extra unreachable daemon was once seen under heavy load, root cause D3.) | no | `d1` |
| D2 | crashed | N clients race over stale files | serving (exactly 1) | **a slow client's zombie cleanup unlinks the new daemon's socket + pid file; every client fails** | no | **BUG** `d2` |
| D3 | absent | N `daemon` processes at once (no lock) | 1 survivor | **several daemons keep running, only one reachable** | no | **BUG** `d3` |
| D4 | crashed | restart | serving | stale files cleaned, T7/T8 applied; idle rule still applies to adopted tasks | `t12` | `d4` |
| D5 | serving | last client process SIGKILLed | idle → shutting_down after 5s → exited | nothing touched during the grace; then SIGTERM → 2s → SIGKILL (grandchildren too), records `killed`, socket + pid removed, exit 0 | `t09` (in-process close, no record/grandchild check) | `d5` |
| D6 | idle | hello within 5s | serving | countdown cancelled; restarts from zero when that client leaves | no | `d6`, `d6b` |
| D7 | idle | only a silent (no hello) connection | exited | — | no | `d7` |
| D8 | shutting_down | hello | shutting_down | refused; shutdown completes | no | `d8` |
| D9 | serving | cli `shutdown` | exited | kills tasks even with an extension still connected; files removed; ext sees EOF | no | `d9` |
| D10 | starting | stale pid (dead) + socket | serving | client path recovers with a new pid | unit (`claim_pid`), `t12` | `d10` |
| D11 | starting | socket without pid file / corrupt pid file | serving | cleaned | unit | `d11`, `d11b` |
| D11b | idle | clients leave one at a time, the last long after the first | exited | the countdown still runs when the last client leaves | no | `g7` |
| D12 | starting | pid file names a live pbs-manager | exits 0 "already running" | — | `t10` | `t10` |
| D13 | starting | pid file names a live unrelated process (pid reuse) | **refuses forever**; clients: "cannot reach pbs-manager" | should take over | no | **BUG** `d12` |
| D14 | serving | SIGTERM / SIGINT to the daemon | exited | same graceful path as D5 | no | `d15` |
| D15 | serving | `shutdown` from an extension; `status` from an extension | serving | shutdown → `E_FORBIDDEN`; status allowed (read-only), returns the hello `cwd` | no | `d16` |
| D16 | serving | Ctrl-C (SIGINT/SIGHUP) to the process group of the client that spawned it | serving | daemon was detached with setsid | no | `g2` |

**Coverage:** 50 cells (C 10, S 6, T 17, D 17).

| | Covered | Partial | Uncovered | Known bug (failing reproducer) |
|---|---|---|---|---|
| Before | 7 | 10 (unit-level, status-only, or in-process close) | 33 | 0 |
| After | 43 | 0 | 0 | 7 |

## Bugs found

All reproduced by tests that fail today; run them with
`cargo test --test lifecycle_adversarial -- --ignored --skip helper_`.

| Test | Bug | Customer impact |
|---|---|---|
| `t6b` | `spawn_kill_reaper` and the shutdown SIGKILL pass only target tasks whose *leader* is still `running`. If the leader dies on SIGTERM but a descendant ignores it, nothing ever SIGKILLs the group. | `stop` reports `killed` while work keeps running; it also outlives the manager. |
| `t6c` | Shutdown signals only groups of tasks marked running. A task that backgrounded a child (`cmd &`) and exited is `completed`, and its group is never signalled. | Violates §3.2 "background tasks must not outlive the last pi". |
| `d2` | Client §3.1 step 5 does `read_pid_file` (stale, dead) then `cleanup_stale_files`. A daemon spawned by a faster client in between loses its socket and pid file. Reproduces within 30 rounds under CPU pressure. | Every client fails with "cannot reach pbs-manager"; an unreachable daemon lingers until idle exit, and its exit cleanup can then delete the *next* daemon's files. |
| `d3` | `claim_pid` is not atomic: a socket bound before its pid file is written looks like a zombie to a concurrent daemon, which unlinks it and binds its own. | Several daemons run; tasks started on an orphaned one become unreachable. (Normally prevented by the spawn lock, but see d2.) |
| `d12` | Pid-file liveness is only `kill(pid, 0)`. After a crash or reboot, a reused pid makes the daemon print "already running" forever; `doctor` does not fix it either. | Manager never starts until the user deletes manager.pid by hand. |
| `o3` | `handle_output` caps a read at 1 MiB of *raw* bytes, but JSON escaping of control bytes expands up to 6x. The >4 MiB response makes `write_frame` fail, the connection's writer task exits, and the connection goes mute. | A `task_output` on binary / ANSI-heavy output hangs the extension's request, and every later request on that connection. |
| `o4` | Chunks are UTF-8-lossy decoded per read; a `max_bytes` or pipe boundary inside a multi-byte character yields U+FFFD and `next_cursor` skips the bytes. | CJK / emoji output is corrupted every 64 KiB (CLI default) and in `watch` events. |
| `t5b` | `signal` is an integer (15/9) on the wire; §3.3 and the extension type (`signal: string \| null`) say `"SIGTERM"`/`"SIGKILL"`. | Extension renders `9`; typed consumers are wrong. The fix is either the doc or the wire. |

## Mutation score

`cargo mutants 27.1.0`, scoped with `-f` to `lifecycle.rs task.rs
registry.rs daemon.rs sys.rs` (216 mutants, 25 unviable, so 191 viable).
"After" = the full run with the new suites, plus targeted reruns for g7/g8,
which were written from that run's survivors. A timeout is an infinite loop
the tests detect by hanging, so it counts as killed.

| File | Viable | Before: caught / timeout / missed | After: caught / timeout / missed |
|---|---|---|---|
| daemon.rs | 90 | 54 / 0 / 36 | 82 / 0 / 8 |
| lifecycle.rs | 22 | 12 / 0 / 10 | 20 / 0 / 2 |
| registry.rs | 15 | 13 / 1 / 1 | 14 / 1 / 0 |
| sys.rs | 15 | 10 / 0 / 5 | 13 / 0 / 2 |
| task.rs | 49 | 38 / 1 / 10 | 39 / 1 / 9 |
| **total** | **191** | **127 / 2 / 62 (67.5%)** | **168 / 2 / 21 (89.0%)** |

The 21 survivors, classified as (a) missing test, (b) equivalent (no
observable difference under the contract), or (c) dead or unneeded code:

| Mutant | Class | Why |
|---|---|---|
| daemon.rs:403:44 `\|\|`→`&&` in maybe_arm_idle_timer | b | The 403 and 411 guards make each other redundant, and every disconnect re-arms anyway. (The sibling 403:20 was a real gap, now killed by `g7`.) |
| daemon.rs:411:36 `&&`→`\|\|` in the idle timer body | b | The timer is aborted on every hello; this guard only covers an abort-vs-wakeup race of microseconds. |
| daemon.rs:507:20 access_for guard → true | b | Differs only for a cli hello that carries a session_id, which the contract never sends (hello does not reject it either). |
| daemon.rs:711:53 `<`→`==`, `<`→`<=`; 713:40 `-`→`+` in handle_output | b | The 64 KB ring is a pure cache of `.output`: taking the disk path, or an over-long `avail` that `slice()` clamps, returns identical bytes (proven by `g1`'s byte-exact sweep). |
| daemon.rs:1004:32 poller guard → true | b | The poller still stops on the next `pid_alive` miss; the guard saves one file read. |
| daemon.rs:1030:24 delete `!` (adopted-poller watcher fanout) | **c** | Unreachable. The catch-up read happens on the interval's immediate first tick, at boot, before any client can `watch`. After that the file never grows, because the task's stdout pipe died with the old manager. Slop candidate: the event fanout block in `spawn_adopted_poller` (lines ~1015–1039); keep the catch-up append. |
| lifecycle.rs:88:23 NotFound guard → true in cleanup_stale_files | b | Only a non-NotFound unlink error (read-only home) behaves differently, and then startup fails either way with a different message. |
| lifecycle.rs:136:19 WouldBlock guard → true | b | Same: only other lock errors differ, and only in the error message. |
| sys.rs:28:34, 42:34 `setsid() == -1` → `== 1` | b | `setsid` cannot fail in a freshly forked non-leader child and never returns 1; the error branch is unreachable but correct. |
| task.rs:22:37 RING_CAPACITY `64*1024`→`64+1024` | b | Ring is cache-only (see 711); a smaller ring only changes performance. Note: no test can tell the ring exists. |
| task.rs:256:23 ×2, 256:32 Interrupted arm in pump_async | **c** | tokio's `AsyncRead` retries EINTR internally and never surfaces `Interrupted`. Slop candidate. |
| task.rs:279:21 `len - offset` → `len + offset` | b | The read loop stops at EOF and `truncate`s, so an oversized `want` is harmless. |
| task.rs:282:16 `<`→`<=` | b | The extra iteration reads into an empty slice and gets `Ok(0)`. (A targeted rerun "caught" it only via a load flake of d1's since-removed process-count assertion.) |
| task.rs:286:23 ×2, 286:32 Interrupted arm in read_file_range | **c** | Regular-file `read` does not return EINTR in practice. Slop candidate: the hand-rolled loop could be `take(max).read_to_end`. |

No (a) remains: the gaps found were closed by `g1`–`g8` (ring and disk
ranges, daemon detach, manager.log reason, CLI session filter, status
counts, re-adopted output catch-up, staggered disconnects, unreadable
output).

## Deferrals

- deferred: HELLO_TIMEOUT (10s) close of a silent connection is not asserted, only that it does not keep the daemon alive | impact: a silent peer holds one fd for 10s; not customer-visible | trigger: if connection limits are added
- deferred: Windows named-pipe path (design §3.1) has no tests; `sys.rs` is unix-only | impact: none until Windows ships | trigger: first Windows build
- deferred: `d2` and `d3` are races; their reproducers add CPU burners and 10–30 rounds, and were red in every run observed, but that is not a proof | impact: an ignored reproducer might pass once by luck | trigger: when fixing, run them ≥10 times
