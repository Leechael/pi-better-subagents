/** Regression replay of READY overtaking the tail-grep fixture's waiting reply. */
import assert from "node:assert/strict";
import { type CtxMessage, say, textOf } from "../../e2e/faux-dsl.ts";
import tailGrep from "./faux-behaviors.ts";

export default {
  steps: [async () => {
    const waiting = tailGrep.steps[1];
    const token = "RACE1234";
    // Foreground completion, captured from the real timing repro at 3104ms.
    const result: CtxMessage = {
      role: "toolResult", toolName: "bash", toolCallId: "tail-call",
      content: [{ type: "text", text: `READY token=${token}\n` }], isError: false,
    };
    // The provider sees custom wakes as user messages, not custom-role messages.
    const wake: CtxMessage = {
      role: "user", content: [{ type: "text", text:
        `<pi-famulus-wake kind="task"><task id="sh_12345678" status="exited"><preview>READY token=${token}</preview></task></pi-famulus-wake>` }],
    };
    for (const incoming of [result, wake]) {
      const answer = typeof waiting === "function"
        ? await waiting({ call: 1, messages: [incoming] }) : waiting;
      assert.equal(textOf({ role: answer.role, content: answer.content }), `The token is ${token}`, `READY swallowed at waiting step (${incoming.role})`);
    }
    const pending: CtxMessage = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "moved to background (task_id: sh_12345678)" }] };
    const answer = typeof waiting === "function" ? await waiting({ call: 1, messages: [pending] }) : waiting;
    assert.equal(textOf({ role: answer.role, content: answer.content }), "Waiting for READY in the background.");
    return say("READY replays passed");
  }],
};
