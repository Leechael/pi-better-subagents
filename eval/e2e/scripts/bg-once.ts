/**
 * (a) A foreground bash command outlives the (tiny) foreground budget, is
 * moved to the background, and wakes the agent exactly once on exit.
 */
import { call, type FauxScript, lastInputText, say } from "../faux-dsl.ts";

export const COMMAND = "echo bg-start; sleep 1.5; echo bg-canary-7731";

const script: FauxScript = {
  steps: [
    call("bash", { command: COMMAND }),
    say("Command is running in the background; ending my turn."),
    // Only reachable if the wake triggers a new turn.
    (ctx) => say(`WAKE-HANDLED ${lastInputText(ctx).includes("bg-canary-7731") ? "saw-canary" : "no-canary"}`),
  ],
};
export default script;
