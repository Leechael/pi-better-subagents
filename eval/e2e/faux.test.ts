/**
 * Part 1: deterministic e2e — real `pi` (RPC mode) + real pbs-manager + our
 * extension, with a scripted faux model. Tests the code, not the model.
 *
 *   node --test e2e/faux.test.ts
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type FauxEpisode, runFaux } from "./run-faux.ts";
import { followedByAssistant, type Item, toolResults, wakes } from "../lib/transcript.ts";
import { PBS_WAKE_LEAD_IN } from "../lib/wake-adapter.ts";

const episodes: FauxEpisode[] = [];
after(() => {
  for (const e of episodes) e.sandbox.cleanup();
});

function explain(ep: FauxEpisode): string {
  const lines = ep.items.map((i) => {
    if (i.kind === "wake") return `#${i.seq} t=${i.t} WAKE ${i.wake.kind} ${i.wake.customType} ${i.wake.taskIds} ${i.wake.status}`;
    if (i.kind === "assistant") return `#${i.seq} t=${i.t} assistant ${JSON.stringify(i.text).slice(0, 80)} ${i.toolCalls.map((c) => c.name)}`;
    if (i.kind === "toolResult") return `#${i.seq} t=${i.t} toolResult ${i.toolName} ${JSON.stringify(i.text).slice(0, 120)}`;
    return `#${i.seq} t=${i.t} ${i.kind}`;
  });
  return `${lines.join("\n")}\nfaux calls: ${ep.calls.length}\nstderr: ${ep.stderr.slice(0, 800)}`;
}

/** Every faux call was scripted: no unexpected LLM requests, no exhaustion. */
function assertScriptConsumedExactly(ep: FauxEpisode, n: number) {
  assert.equal(ep.calls.length, n, `expected ${n} model calls\n${explain(ep)}`);
  assert.ok(ep.calls.every((c) => c.scripted), `unscripted model call\n${explain(ep)}`);
}

const bashResult = (items: Item[]) => toolResults(items).find((r) => r.toolName === "bash");

describe("faux e2e", { concurrency: true }, () => {
  it("(a) command over the foreground budget is backgrounded and notifies exactly once", async () => {
    const ep = await runFaux({
      script: "bg-once.ts",
      pbsConfig: { foregroundBudgetMs: 300 },
      until: (items) => wakes(items).length >= 1 && followedByAssistant(items, wakes(items)[0].seq),
      quietMs: 2500, // long enough for a duplicate notification to show up
    });
    episodes.push(ep);
    const result = bashResult(ep.items);
    assert.ok(result, explain(ep));
    assert.equal(result.details?.backgrounded, true, `tool result not backgrounded\n${explain(ep)}`);
    const taskId = String(result.details?.task_id);
    assert.match(taskId, /^sh_[0-9a-f]{8}$/);
    assert.match(result.text, new RegExp(`moved to background \\(task_id: ${taskId}\\)`));

    const ws = wakes(ep.items);
    assert.equal(ws.length, 1, `expected exactly one wake\n${explain(ep)}`);
    const [w] = ws;
    assert.equal(w.wake.customType, "pbs-wake");
    assert.equal(w.wake.source, "details", "wake details missing from the event stream");
    assert.equal(w.wake.tasks[0].exitCode, 0);
    assert.equal(w.wake.leadIn, PBS_WAKE_LEAD_IN);
    assert.equal(w.wake.kind, "task");
    assert.deepEqual(w.wake.taskIds, [taskId]);
    assert.equal(w.wake.status, "completed");
    assert.match(w.wake.body, /bg-canary-7731/);
    assert.ok(w.seq > result.seq);

    // The wake started a new model turn, and that turn saw the payload.
    assert.ok(followedByAssistant(ep.items, w.seq), `wake did not trigger a turn\n${explain(ep)}`);
    const last = ep.items.at(-1);
    assert.equal(last?.kind, "assistant");
    assert.match((last as { text: string }).text, /WAKE-HANDLED saw-canary/);
    assertScriptConsumedExactly(ep, 3);
  });

  it("(b) command within the foreground budget returns inline and produces no notification", async () => {
    const ep = await runFaux({
      script: "fg-quiet.ts",
      pbsConfig: { foregroundBudgetMs: 10_000 },
      quietMs: 2000,
    });
    episodes.push(ep);
    const result = bashResult(ep.items);
    assert.ok(result, explain(ep));
    assert.equal(result.isError, false);
    assert.match(result.text, /fg-quick-4410/);
    assert.notEqual(result.details?.backgrounded, true);
    assert.equal(wakes(ep.items).length, 0, `unexpected wake\n${explain(ep)}`);
    assert.equal(ep.items.filter((i) => i.kind === "custom").length, 0, explain(ep));
    assertScriptConsumedExactly(ep, 2);
  });

  it("(c) monitor lines arrive as monitor events, then exactly one timeout notice", async () => {
    const ep = await runFaux({
      script: "monitor-timeout.ts",
      until: (items) => wakes(items).some((w) => w.wake.status === "timeout"),
      quietMs: 2000,
    });
    episodes.push(ep);
    const monitorResult = toolResults(ep.items).find((r) => r.toolName === "monitor");
    assert.ok(monitorResult && !monitorResult.isError, explain(ep));
    const taskId = String(monitorResult.details?.task_id);
    assert.match(taskId, /^mon_[0-9a-f]{8}$/);

    const ws = wakes(ep.items);
    assert.ok(ws.every((w) => w.wake.customType === "pbs-wake" && w.wake.kind === "monitor"), explain(ep));
    assert.ok(ws.every((w) => w.wake.taskIds[0] === taskId), explain(ep));
    const events = ws.filter((w) => w.wake.status === "event");
    const timeouts = ws.filter((w) => w.wake.status === "timeout");
    assert.ok(events.length >= 1, `no monitor events\n${explain(ep)}`);
    // All lines delivered, in order, across however many batches.
    const lines = events.flatMap((w) => w.wake.body.split("\n")).filter(Boolean);
    assert.deepEqual(lines, ["tick-1", "tick-2", "tick-3"], explain(ep));
    assert.equal(timeouts.length, 1, `expected one timeout notice\n${explain(ep)}`);
    assert.match(timeouts[0].wake.body, /Monitor timed out — re-arm if needed/);
    assert.ok(events.every((w) => w.seq < timeouts[0].seq), "event after timeout");
    // Killed by the timeout: no separate "exited" notice.
    assert.equal(ws.filter((w) => w.wake.status === "exited").length, 0, explain(ep));
    // Wakes got model turns (idle → triggerTurn; busy → steered into the running turn).
    assert.ok(followedByAssistant(ep.items, timeouts[0].seq), `timeout did not wake the agent\n${explain(ep)}`);
    const lastText = (ep.items.at(-1) as { text?: string }).text ?? "";
    assert.match(lastText, /WOKE: timeout/);
  });

  it(
    "behavior guidelines are in the system prompt of the wake-triggered turn",
    // Regression: guidelines used to be a forced before_agent_start systemPrompt,
    // which wake-triggered runs never saw (fixed in a164135).
    async () => {
      const ep = await runFaux({
        script: "bg-once.ts",
        pbsConfig: { foregroundBudgetMs: 300 },
        until: (items) => wakes(items).length >= 1 && followedByAssistant(items, wakes(items)[0].seq),
      });
      episodes.push(ep);
      const heading = "Background tasks and notifications (pi-better-subagents)";
      const sees = ep.calls.map((c) => JSON.stringify(c.messages).includes(heading));
      assert.equal(sees.length, 3, explain(ep));
      assert.ok(sees[0], "guidelines missing on the user-prompted turn");
      assert.ok(sees[2], "guidelines missing on the wake-triggered turn");
    },
  );

  it(
    "subagent children can call contact_supervisor",
    // Regression: the child tool allowlist used to filter out custom tools.
    async () => {
      const ep = await runFaux({
        script: "exercise-surfaces.ts",
        pbsConfig: { foregroundBudgetMs: 300 },
        until: (items) => wakes(items).some((w) => w.wake.kind === "subagent-done"),
        untilTimeoutMs: 15_000,
      });
      episodes.push(ep);
      const childSawTool = ep.calls.some((c) =>
        c.messages.some((m) => m.role === "system" && JSON.stringify(m).includes('"name":"contact_supervisor"')),
      );
      assert.ok(childSawTool, "contact_supervisor is not declared in any child session");
      assert.ok(wakes(ep.items).some((w) => w.wake.kind === "supervisor-request"), explain(ep));
    },
  );

  it(
    "cold start: first backgrounded command right after launch still notifies",
    // Regression: concurrent connects rebound each other and the manager exited,
    // killing the task (fixed in c59d926).
    async () => {
      const ep = await runFaux({
        script: "bg-once.ts",
        pbsConfig: { foregroundBudgetMs: 300 },
        warm: false,
        until: (items) => wakes(items).length >= 1,
        untilTimeoutMs: 6000,
      });
      episodes.push(ep);
      assert.equal(wakes(ep.items).length, 1, `no task wake after cold start\n${explain(ep)}`);
    },
  );
});
