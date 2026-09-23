/**
 * A monitor whose command prints once and exits immediately (`echo noop`).
 * Manual testing (2026-09-24) found it stuck "running" until its timeout: the
 * line and the exit arrived before the extension registered the monitor.
 * After the exit wake the model lists tasks; nothing should still be running.
 */
import { call, type FauxScript, lastInputText, say } from "../faux-dsl.ts";

let listed = false;
const script: FauxScript = {
  steps: [
    call("monitor", { command: "echo noop", description: "quick watcher", timeout_ms: 4000 }),
    say("Monitor armed."),
  ],
  fallback: (ctx) => {
    const input = lastInputText(ctx);
    if (!listed && /exited|timed out/.test(input)) {
      listed = true;
      return call("task_list", {});
    }
    return say(listed ? "LISTED" : "WOKE");
  },
};
export default script;
