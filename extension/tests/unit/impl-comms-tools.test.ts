import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComms } from "../../src/comms/comms";
import {
  createAgentMessageTool,
  createContactSupervisorTool,
} from "../../src/comms/tools";
import type {
  ChildHandle,
  ChildResult,
  ChildStatus,
  CommsHost,
} from "../../src/comms/types";

// ---------------------------------------------------------------------------
// mock CommsHost (same shape as impl-comms-core.test.ts)
// ---------------------------------------------------------------------------

interface HandleCalls {
  steer: string[];
  followUp: string[];
  resume: string[];
}

function fakeHandle(childId: string, calls: HandleCalls): ChildHandle {
  return {
    childId,
    result: new Promise<ChildResult>(() => {}),
    steer: async (m) => {
      calls.steer.push(m);
    },
    followUp: async (m) => {
      calls.followUp.push(m);
    },
    resume: async (m) => {
      calls.resume.push(m);
    },
    interrupt: async () => {},
    status: () => "running",
    lastEventAt: () => 0,
  };
}

class FakeHost implements CommsHost {
  readonly children = new Map<
    string,
    { handle: ChildHandle; runId: string; name: string; status: ChildStatus }
  >();
  readonly calls = new Map<string, HandleCalls>();
  readonly notifications: string[] = [];

  add(childId: string, runId: string, name: string, status: ChildStatus): HandleCalls {
    const calls: HandleCalls = { steer: [], followUp: [], resume: [] };
    this.calls.set(childId, calls);
    this.children.set(childId, { handle: fakeHandle(childId, calls), runId, name, status });
    return calls;
  }

  getChild(childId: string) {
    return this.children.get(childId);
  }
  listChildren() {
    return [...this.children.entries()].map(([childId, c]) => ({
      childId,
      runId: c.runId,
      name: c.name,
      status: c.status,
    }));
  }
  sameRun(a: string, b: string) {
    const ca = this.children.get(a);
    const cb = this.children.get(b);
    return !!ca && !!cb && ca.runId === cb.runId;
  }
  notifySupervisor(content: string) {
    this.notifications.push(content);
  }
}

const CTX = {} as ExtensionContext;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Extract the text of a tool result's first content block (assumes text). */
function textOf(res: { content: ({ type: "text"; text: string } | { type: string })[] }): string {
  const first = res.content[0];
  if (first.type !== "text") throw new Error("expected text content");
  return (first as { type: "text"; text: string }).text;
}

// ---------------------------------------------------------------------------

describe("contact_supervisor tool", () => {
  it("progress_update returns ok immediately", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);
    const tool = createContactSupervisorTool(comms, "ch_a");

    const res = await tool.execute(
      "tc1",
      { reason: "progress_update", message: "halfway" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.content[0]).toEqual({ type: "text", text: "ok" });
    expect(res.details).toMatchObject({ reason: "progress_update", replied: false });
    expect(host.notifications[0]).toContain("<supervisor-update");
  });

  it("need_decision blocks and returns the supervisor reply as tool text", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);
    const tool = createContactSupervisorTool(comms, "ch_a");

    const p = tool.execute(
      "tc2",
      { reason: "need_decision", message: "delete the cache?" },
      undefined,
      undefined,
      CTX,
    );
    await tick();
    expect(host.notifications[0]).toContain("<supervisor-request");
    comms.reply("ch_a", "yes, delete it");

    const res = await p;
    expect(res.content[0]).toEqual({ type: "text", text: "yes, delete it" });
    expect(res.details).toMatchObject({ reason: "need_decision", replied: true });
  });
});

describe("agent_message tool (parent sender)", () => {
  function setup() {
    const host = new FakeHost();
    const a = host.add("ch_a", "run_1", "explorer", "running");
    const b = host.add("ch_b", "run_1", "worker", "running");
    host.add("ch_c", "run_1", "done-one", "completed");
    host.add("ch_d", "run_2", "other-run", "running");
    const comms = createComms(host);
    const tool = createAgentMessageTool(comms, { kind: "parent" }, host);
    return { host, comms, tool, a, b };
  }

  it("send defaults to steer delivery, resolvable by name", async () => {
    const { tool, a } = setup();
    const res = await tool.execute(
      "t1",
      { action: "send", to: "explorer", message: "look at src/" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details).toMatchObject({ ok: true, to: "ch_a", delivery: "steer" });
    expect(a.steer).toEqual(["look at src/"]);
    expect(textOf(res)).toContain("ch_a");
  });

  it("send with queue delivery uses followUp", async () => {
    const { tool, b } = setup();
    await tool.execute(
      "t2",
      { action: "send", to: "ch_b", message: "later", delivery: "queue" },
      undefined,
      undefined,
      CTX,
    );
    expect(b.followUp).toEqual(["later"]);
    expect(b.steer).toEqual([]);
  });

  it("send to a finished child resumes it", async () => {
    const { tool, host } = setup();
    const res = await tool.execute(
      "t3",
      { action: "send", to: "ch_c", message: "again please" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details).toMatchObject({ ok: true });
    expect(host.calls.get("ch_c")!.resume).toEqual(["again please"]);
    expect(textOf(res)).toContain("resumed");
  });

  it("send without to or message returns a clear error text", async () => {
    const { tool } = setup();
    const noTo = await tool.execute(
      "t4",
      { action: "send", message: "hi" },
      undefined,
      undefined,
      CTX,
    );
    expect(textOf(noTo)).toContain('Error: action "send" requires "to"');
    expect(noTo.details.ok).toBe(false);

    const noMsg = await tool.execute(
      "t5",
      { action: "send", to: "ch_a" },
      undefined,
      undefined,
      CTX,
    );
    expect(textOf(noMsg)).toContain('Error: action "send" requires "message"');
  });

  it("send to an unknown child returns an error listing known children", async () => {
    const { tool } = setup();
    const res = await tool.execute(
      "t6",
      { action: "send", to: "ch_nope", message: "hi" },
      undefined,
      undefined,
      CTX,
    );
    expect(textOf(res)).toContain('Unknown child "ch_nope"');
    expect(textOf(res)).toContain("ch_a (explorer)");
    expect(res.details.ok).toBe(false);
  });

  it("reply resolves the child's pending need_decision", async () => {
    const { tool, comms } = setup();
    const waiting = comms.contactSupervisor("ch_a", "need_decision", "which one?");
    await tick();

    const res = await tool.execute(
      "t7",
      { action: "reply", to: "ch_a", message: "the first one" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details).toMatchObject({ ok: true, to: "ch_a" });
    await expect(waiting).resolves.toBe("the first one");
  });

  it("reply without a pending request returns an error naming the pending children", async () => {
    const { tool, comms } = setup();
    void comms.contactSupervisor("ch_b", "need_decision", "still waiting");
    await tick();

    const res = await tool.execute(
      "t8",
      { action: "reply", to: "ch_a", message: "nobody asked" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.ok).toBe(false);
    expect(textOf(res)).toContain("No pending decision request from ch_a");
    expect(textOf(res)).toContain("ch_b (worker)");
  });

  it("broadcast requires to=run_id and reports delivered children", async () => {
    const { tool, a, b, host } = setup();
    const missing = await tool.execute(
      "t9",
      { action: "broadcast", message: "hi" },
      undefined,
      undefined,
      CTX,
    );
    expect(textOf(missing)).toContain('Error: action "broadcast" requires "to"');

    const res = await tool.execute(
      "t10",
      { action: "broadcast", to: "run_1", message: "wrap up" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details).toMatchObject({ ok: true, delivered: ["ch_a", "ch_b"] });
    expect(a.steer).toEqual(["wrap up"]);
    expect(b.steer).toEqual(["wrap up"]);
    expect(host.calls.get("ch_d")!.steer).toEqual([]); // other run untouched
  });

  it("list shows children, pending requests and recent log entries", async () => {
    const { tool, comms } = setup();
    void comms.contactSupervisor("ch_a", "need_decision", "pick a file");
    await comms.send("ch_b", "hello", "steer");
    await tick();

    const res = await tool.execute("t11", { action: "list" }, undefined, undefined, CTX);
    const text = textOf(res);
    expect(text).toContain("Pending decision requests: 1");
    expect(text).toContain("ch_a (explorer)");
    expect(text).toContain("pick a file");
    expect(text).toContain("ch_d [run_2] other-run — running");
    expect(text).toContain("supervisor → ch_b (send)");
    expect(res.details).toMatchObject({ ok: true, action: "list" });
    expect(res.details.pending).toHaveLength(1);
    expect(res.details.children).toHaveLength(4);
  });
});

describe("agent_message tool (child sender)", () => {
  function setup() {
    const host = new FakeHost();
    const a = host.add("ch_a", "run_1", "explorer", "running");
    const b = host.add("ch_b", "run_1", "worker", "running");
    const d = host.add("ch_d", "run_2", "other-run", "running");
    const comms = createComms(host);
    const tool = createAgentMessageTool(
      comms,
      { kind: "child", childId: "ch_a", runId: "run_1" },
      host,
    );
    return { host, comms, tool, a, b, d };
  }

  it("send to a sibling in the same run succeeds and is attributed to the child", async () => {
    const { tool, comms, b } = setup();
    const res = await tool.execute(
      "c1",
      { action: "send", to: "ch_b", message: "I found the bug" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.ok).toBe(true);
    expect(b.steer).toEqual(["I found the bug"]);
    const log = comms.log("run_1");
    expect(log[0]).toMatchObject({ from: "ch_a", to: "ch_b", kind: "send" });
  });

  it("send across runs is rejected with the cross-run error", async () => {
    const { tool, d } = setup();
    const res = await tool.execute(
      "c2",
      { action: "send", to: "ch_d", message: "hello other run" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.ok).toBe(false);
    expect(textOf(res)).toContain("cross-run messaging not allowed");
    expect(d.steer).toEqual([]);
  });

  it("send to itself is rejected", async () => {
    const { tool, a } = setup();
    const res = await tool.execute(
      "c3",
      { action: "send", to: "ch_a", message: "note to self" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.ok).toBe(false);
    expect(textOf(res)).toContain("cannot send a message to itself");
    expect(a.steer).toEqual([]);
  });

  it("broadcast goes to own run, excluding the sender", async () => {
    const { tool, a, b, d } = setup();
    const res = await tool.execute(
      "c4",
      { action: "broadcast", message: "found something" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details).toMatchObject({ ok: true, delivered: ["ch_b"] });
    expect(a.steer).toEqual([]);
    expect(b.steer).toEqual(["found something"]);
    expect(d.steer).toEqual([]);
  });

  it("broadcast with a foreign run_id is rejected", async () => {
    const { tool } = setup();
    const res = await tool.execute(
      "c5",
      { action: "broadcast", to: "run_2", message: "infiltrate" },
      undefined,
      undefined,
      CTX,
    );
    expect(res.details.ok).toBe(false);
    expect(textOf(res)).toContain("cross-run messaging not allowed");
  });

  it("list is scoped to the sender's run log", async () => {
    const { tool, comms } = setup();
    await comms.send("ch_a", "from parent", "steer"); // run_1
    await comms.send("ch_d", "other run traffic", "steer"); // run_2

    const res = await tool.execute("c6", { action: "list" }, undefined, undefined, CTX);
    const text = textOf(res);
    expect(text).toContain("from parent");
    expect(text).not.toContain("other run traffic");
  });
});
