/**
 * A `grep -m1`-style monitor: one line, then exit, both arriving while the
 * model is still writing its reply (here, a 3s response). Real-model eval
 * batches 2–4 had the exit notice ahead of the event in 25 of 125 monitors:
 * the event is steered in at the next turn_start, and the no-turn exit
 * notice was appended at the turn_end before it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { call, type FauxScript, say } from "../faux-dsl.ts";

const script: FauxScript = {
  steps: [
    call("monitor", { command: "sleep 1; echo READY token=T1", description: "ready", timeout_ms: 30000 }),
    async () => {
      await sleep(3000);
      return say("Waiting for READY.");
    },
  ],
  fallback: say("The token is T1."),
};
export default script;
