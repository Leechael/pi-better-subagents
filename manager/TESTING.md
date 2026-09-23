# pbs-manager testing

How the manager is tested, what the tests are known to guard, and where the
gaps are. Contract sources: `docs/design.md` §3 and `docs/cli.md`.

## Suites

| Suite | Kind | What it covers |
|---|---|---|
| `src/**` `#[cfg(test)]` | unit | ring buffer, record persistence, state mapping, daemon lock claim, UTF-8 chunk cutting, signal names, id format |
| `tests/protocol.rs` | black box | message round-trips, basic lifecycle (t01–t13) |
| `tests/lifecycle_adversarial.rs` | black box | every cell of the lifecycle table below, adversarial conditions |
| `tests/mutation_gaps.rs` | black box | behaviours found unguarded by cargo-mutants survivors (g1–g13) |
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
- Race tests (`d2`) add CPU burners (one per core) for the test's duration
  to widen scheduler windows; this made the original race fail every time.
- Cleanup: each `Home` kills every recorded task process group and the
  daemon on drop, even when the test panics.

```bash
cd manager
cargo test                                               # everything (~42s wall, warm build)
cargo test --test lifecycle_adversarial                  # adversarial suite
scripts/ablate.sh                                        # ablation check (~20 min idle)
cargo mutants -j 3 --timeout 150 -f src/lifecycle.rs -f src/task.rs -f src/registry.rs \
  -f src/daemon.rs -f src/sys.rs -f src/proto.rs          # mutation score (~55 min)
```

Measured on an M-series Mac with a warm build: `cargo test` takes 42s wall
for 102 passing tests: unit 0.2s (34), `lifecycle_adversarial` 19s (42),
`mutation_gaps` 14s (13), `protocol` 8s (13). Binaries run one after
another; tests inside a binary run in parallel. The suite is stable across
repeated runs and with 3 concurrent copies of the integration suites. Most
of the time goes to the contract's own timers (5s grace, 2s kill grace).

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
| D1 | absent | N clients race to auto-spawn | serving | every client succeeds, reaches the same pid; exactly one daemon process | no | `d1` |
| D2 | crashed | N clients race over stale files | serving | clients never delete files; exactly one reachable daemon; no client fails | no | **FIXED** `d2` |
| D3 | absent | N `daemon` processes at once (no spawn lock) | 1 survivor | lifetime lock on manager.lock: losers exit 0 "already running" | no | **FIXED** `d3` |
| D4 | crashed | restart | serving | lock holder removes stale files; T7/T8 applied; idle rule still applies to adopted tasks | `t12` | `d4` |
| D5 | serving | last client process SIGKILLed | idle → shutting_down after 5s → exited | nothing touched during the grace; then SIGTERM → 2s → SIGKILL (grandchildren too), records `killed`, socket + pid removed, exit 0 | `t09` (in-process close) | `d5` |
| D6 | idle | hello within 5s | serving | countdown cancelled; restarts from zero when that client leaves | no | `d6`, `d6b` |
| D7 | idle | only a silent (no hello) connection | exited | — | no | `d7` |
| D8 | shutting_down | hello | shutting_down | refused; shutdown completes | no | `d8` |
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

**Coverage:** 55 cells (C 10, S 6, T 20, D 19).

| | Covered | Partial | Uncovered | Violated by the code |
|---|---|---|---|---|
| Before (original code, original tests) | 7 | 10 (unit-level, status-only, or in-process close) | 38 | 8 (C10, T6b, T6c, T15, T16, D2, D3, D13) |
| After (fixed code) | 55 | 0 | 0 | 0 |

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
| `t5b` | `signal` was an integer on the wire and on disk; §3.3 and the extension type say `"SIGTERM"`/`"SIGKILL"`. | `signal` is a name (`proto::signal_name`) in `task_exited`, `TaskRecord` and the CLI `EXIT` column (widened to 7). Legacy numeric records still load (converted). The extension only tests truthiness / displays it; verified with `tsc`, its unit tests, and its real-binary integration tests. | `t5b`, `t2`, unit `signal_names_on_wire_and_legacy_numbers_load` |

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

`ablation.toml` lists 29 load-bearing mechanisms, each with a literal
find/replace and the tests that must go red. `scripts/ablate.sh` applies
each one to a scratch copy (sharing one build cache), first checks that
every listed test passes on the pristine copy (a test that is already red
proves nothing), then runs them one by one and compares the result with
`expect`. Per-test logs go to `$ABLATE_WORK/logs/`. Needs `cargo`,
`python3` ≥ 3.11 (tomllib), `perl`, `rsync`.

Final pass on the fixed code: **29/29 entries behave as declared** (28 red,
1 green), with no baseline flakes and exit status 0.

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
| daemon-lifetime-lock (guard dropped at startup) | 2/2: t10, d3 |
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

No removal turned a test red.

## Deferrals

- deferred: HELLO_TIMEOUT (10s) close of a silent connection is not asserted, only that it does not keep the daemon alive | impact: a silent peer holds one fd for 10s; not customer-visible | trigger: if connection limits are added
- deferred: Windows named-pipe path (design §3.1) has no tests; `sys.rs` is unix-only | impact: none until Windows ships | trigger: first Windows build
- deferred: a client that connects while the daemon is in graceful shutdown (accept loop gone, listener still bound) waits for its 30s hello timeout instead of failing fast and spawning a successor | impact: rare 30s stall right after an idle shutdown | trigger: any report of a slow first command after idle
- deferred: re-adopted tasks are identified by pid liveness only (`kill(pid,0)`); a task pid reused while no manager ran would be re-adopted, and signalled on stop/shutdown | impact: wrong process signalled after a crash plus a long gap | trigger: persisting process start time in TaskRecord (a contract change)
- deferred: `c6` failed once on a pristine copy during an early ablation pass (no log kept then); it passed every other run, with typical margins of 17 MiB RSS growth against 96 MiB and ~10ms latency against 2s. ablate.sh now keeps per-test logs | impact: possible rare flake | trigger: the next c6 failure
