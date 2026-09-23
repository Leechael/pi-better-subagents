/**
 * A backgrounded command is running when pbs-manager is killed with
 * SIGKILL. The runner takes the command down (lifeline); the extension
 * reconnects to a fresh manager, which lists the task as orphaned
 * (manager-crash), and the agent gets that as the command's exit wake
 * instead of waiting forever.
 */
import { call, type FauxScript, lastInputText, say } from "../faux-dsl.ts";

export const COMMAND = "echo crash-start; sleep 30; echo never-printed";

const script: FauxScript = {
  steps: [
    call("bash", { command: COMMAND }),
    say("Running in the background; ending my turn."),
  ],
  fallback: (ctx) => say(`WOKE ${lastInputText(ctx).includes("orphaned") ? "orphaned" : "other"}`),
};
export default script;
