/**
 * A finite event-driven wait. BSD tail -F stays alive after grep -m1 exits;
 * GNU tail on macOS can mistake a readable named FIFO for a broken pipe.
 * Bash owns the anonymous-pipe producer PID and reaps it after grep finishes.
 */
export const TAIL_GREP_COMMAND = `/bin/bash <<'WAIT_READY'
exec 3< <(exec tail -n +1 -F service.log)
tail_pid=$!
trap 'status=$?; exec 3<&-; kill "$tail_pid" 2>/dev/null || :; wait "$tail_pid" 2>/dev/null || :; exit "$status"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
grep --line-buffered -m1 READY <&3
WAIT_READY`;
