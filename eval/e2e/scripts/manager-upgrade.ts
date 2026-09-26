/**
 * A backgrounded command and a streaming monitor are running when the
 * manager is upgraded in place (`pbs-manager upgrade`, exec with the same
 * pid). Neither notices: the command's single exit wake carries its real
 * exit code, and every monitor line reaches the agent once, in order.
 */
import { calls, type FauxScript, say } from "../faux-dsl.ts";

export const BASH_COMMAND = "i=1; while [ $i -le 40 ]; do echo b-$i; i=$((i+1)); sleep 0.05; done; exit 5";
// Three bursts of ten lines, a second apart: a few batches, well inside the
// monitor's rate limit (10 batches, +1 per 2 s), spanning the upgrade.
export const MONITOR_COMMAND =
  "for b in 1 2 3; do i=1; while [ $i -le 10 ]; do echo m-$(( (b - 1) * 10 + i )); i=$((i+1)); done; sleep 1; done";

const script: FauxScript = {
  steps: [
    calls([
      ["bash", { command: BASH_COMMAND }],
      ["monitor", { command: MONITOR_COMMAND, description: "upgrade watcher", timeout_ms: 30000 }],
    ]),
    say("Both running; ending my turn."),
  ],
  fallback: () => say("WOKE"),
};
export default script;
