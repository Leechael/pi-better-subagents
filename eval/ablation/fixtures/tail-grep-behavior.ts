/** Environment-free tail-grep behavior shared by the selector and READY replay. */
import { call, type FauxCallContext, type FauxScript, lastInputText, say } from "../../e2e/faux-dsl.ts";
import { TAIL_GREP_COMMAND } from "./tail-grep-command.ts";

function readyReply(ctx: FauxCallContext, otherwise: string) {
  const m = /token=([A-Z0-9]+)/.exec(lastInputText(ctx));
  return say(m ? `The token is ${m[1]}` : otherwise);
}

/** A READY can arrive in the foreground result or overtake the waiting reply. */
export function waitingReply(ctx: FauxCallContext) {
  return readyReply(ctx, "Waiting for READY in the background.");
}

export const tailGrepBehavior: FauxScript = {
  steps: [call("bash", { command: TAIL_GREP_COMMAND }), waitingReply],
  fallback: (ctx) => readyReply(ctx, "ok"),
};
