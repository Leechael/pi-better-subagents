#!/usr/bin/env bash
# Code-ablation runner for pbs-manager.
#
# For every entry in manager/ablation.toml:
#   1. copy manager/ (without build dirs) into a scratch directory,
#   2. apply the entry's literal find/replace (the find string must occur
#      exactly once, otherwise the manifest is stale and the entry errors),
#   3. build, then run each listed test on its own,
#   4. assert the outcome matches `expect`:
#        red   -> every listed test fails (or hangs past the timeout)
#        green -> every listed test still passes (documented redundancy)
# Before any ablation, the listed tests are run once on the pristine copy:
# a test that is already red proves nothing and is reported as BASELINE-RED.
#
# Usage:
#   manager/scripts/ablate.sh                 # all entries
#   manager/scripts/ablate.sh spawn-lock ...  # selected ids
# Env:
#   ABLATE_WORK          scratch dir (default: mktemp); reused build cache
#   ABLATE_TEST_TIMEOUT  per-test timeout in seconds (default 180)
#   ABLATE_FEATURES      cargo features for the build and tests (default
#                        test-clock: lifecycle timers run on the manual
#                        clock; set it empty for real time)
#
# Per-test output is kept in $ABLATE_WORK/logs/<ablation-id|baseline>--<test>.log.
# Requires: cargo, python3 (>= 3.11, for tomllib), perl, rsync.
# Exit status: 0 when every entry behaves as declared, 1 otherwise.

set -euo pipefail

MANAGER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$MANAGER_DIR/ablation.toml"
WORK="${ABLATE_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pbs-ablate.XXXXXX")}"
TEST_TIMEOUT="${ABLATE_TEST_TIMEOUT:-180}"
FEATURES="${ABLATE_FEATURES-test-clock}"
FEATURE_ARGS=(--features "$FEATURES")
[ -n "$FEATURES" ] || FEATURE_ARGS=()
COPY="$WORK/manager"
export CARGO_TARGET_DIR="$WORK/target"
mkdir -p "$WORK/logs"

manifest() {
  python3 - "$MANIFEST" "$@" <<'PY'
import sys, tomllib, pathlib
manifest, cmd, *args = sys.argv[1:]
entries = tomllib.loads(pathlib.Path(manifest).read_text())["ablation"]
by_id = {e["id"]: e for e in entries}
if cmd == "ids":
    print("\n".join(e["id"] for e in entries))
elif cmd == "all-tests":
    seen = []
    for e in entries:
        if args and e["id"] not in args:
            continue
        for t in e["tests"]:
            if t not in seen:
                seen.append(t)
    print("\n".join(seen))
elif cmd == "tests":
    print("\n".join(by_id[args[0]]["tests"]))
elif cmd == "field":
    print(by_id[args[0]].get(args[1], ""))
elif cmd == "apply":
    e, root = by_id[args[0]], pathlib.Path(args[1])
    path = root / e["file"]
    src = path.read_text()
    n = src.count(e["find"])
    if n != 1:
        print(f"find string occurs {n} times in {e['file']} (manifest stale?)", file=sys.stderr)
        sys.exit(3)
    path.write_text(src.replace(e["find"], e["replace"], 1))
else:
    sys.exit(f"unknown command {cmd}")
PY
}

fresh_copy() {
  # No -t: a file that differs from the pristine tree (the previous
  # ablation's edit) is rewritten with a *new* mtime, so cargo rebuilds.
  # Preserving the original, older mtime would make cargo keep the ablated
  # binary, and the next baseline would silently test the wrong code.
  rsync -rlp --checksum --delete --exclude 'target' --exclude 'target-*' --exclude 'mutants.out*' \
    "$MANAGER_DIR/" "$COPY/"
}

build() {
  (cd "$COPY" && cargo test --no-run -q ${FEATURE_ARGS[@]+"${FEATURE_ARGS[@]}"} >"$WORK/build.log" 2>&1)
}

# run_test <target::name> -> prints PASS | FAIL | TIMEOUT
run_test() {
  local target="${1%%::*}" name="${1##*::}" rc=0 log="$WORK/logs/${2:-run}--${1##*::}.log"
  (cd "$COPY" && perl -e 'alarm shift; exec @ARGV' "$TEST_TIMEOUT" \
    cargo test -q ${FEATURE_ARGS[@]+"${FEATURE_ARGS[@]}"} --test "$target" -- --exact "$name" >"$log" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    if grep -q "1 passed" "$log"; then echo PASS; else echo "NOTRUN"; fi
  elif [ "$rc" -eq 142 ] || [ "$rc" -eq 14 ]; then
    echo TIMEOUT
  else
    echo FAIL
  fi
}

if [ "$#" -gt 0 ]; then IDS=("$@"); else
  IDS=()
  while IFS= read -r line; do IDS+=("$line"); done < <(manifest ids)
fi

echo "work dir: $WORK"
echo "== baseline (pristine copy): listed tests must pass"
fresh_copy
build || { echo "baseline build failed"; cat "$WORK/build.log"; exit 1; }
BASELINE_RED=""
while IFS= read -r t; do
  r="$(run_test "$t" baseline)"
  printf '  %-8s %s\n' "$r" "$t"
  [ "$r" = PASS ] || BASELINE_RED="$BASELINE_RED $t "
done < <(manifest all-tests "${IDS[@]}")

status=0
declare -a SUMMARY
for id in "${IDS[@]}"; do
  expect="$(manifest field "$id" expect)"
  echo "== ablation $id (expect $expect): $(manifest field "$id" mechanism)"
  fresh_copy
  if ! manifest apply "$id" "$COPY"; then
    SUMMARY+=("$id|$expect|ERROR (stale manifest)")
    status=1
    continue
  fi
  if ! build; then
    echo "  build failed:"; tail -20 "$WORK/build.log" | sed 's/^/    /'
    SUMMARY+=("$id|$expect|ERROR (does not compile)")
    status=1
    continue
  fi
  ok=1 reds=0 total=0
  while IFS= read -r t; do
    total=$((total + 1))
    r="$(run_test "$t" "$id")"
    note=""
    case "$BASELINE_RED" in *" $t "*) note=" (BASELINE-RED: proves nothing)";; esac
    printf '  %-8s %s%s\n' "$r" "$t" "$note"
    if [ "$r" = FAIL ] || [ "$r" = TIMEOUT ]; then reds=$((reds + 1)); fi
    if [ "$expect" = red ] && { [ "$r" = PASS ] || [ "$r" = NOTRUN ] || [ -n "$note" ]; }; then ok=0; fi
    if [ "$expect" = green ] && [ "$r" != PASS ]; then ok=0; fi
  done < <(manifest tests "$id")
  if [ "$ok" = 1 ]; then verdict="OK"; else verdict="MISMATCH"; status=1; fi
  SUMMARY+=("$id|$expect|$verdict ($reds/$total red)")
done

echo
echo "== summary"
printf '%-36s %-6s %s\n' "ABLATION" "EXPECT" "RESULT"
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r a b c <<<"$row"
  printf '%-36s %-6s %s\n' "$a" "$b" "$c"
done
exit "$status"
