import { describe, expect, it } from "vitest";
import { createComms, formatSupervisorRequest } from "../../src/comms/comms";
import { DECISION_TIMEOUT_MESSAGE } from "../../src/comms/mailbox";
import type {
  ChildHandle,
  ChildResult,
  ChildStatus,
  CommsHost,
} from "../../src/comms/types";

// ---------------------------------------------------------------------------
// mock CommsHost: in-memory children with call-recording fake handles
// ---------------------------------------------------------------------------

interface HandleCalls {
  steer: string[];
  followUp: string[];
  resume: string[];
}

function fakeHandle(childId: string, calls: HandleCalls, failSteer = false): ChildHandle {
  return {
    childId,
    result: new Promise<ChildResult>(() => {}),
    steer: async (m) => {
      if (failSteer) throw new Error("child went away");
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
    resolvedModel: () => undefined,
  };
}

class FakeHost implements CommsHost {
  readonly children = new Map<
    string,
    { handle: ChildHandle; runId: string; name: string; status: ChildStatus }
  >();
  readonly calls = new Map<string, HandleCalls>();
  readonly notifications: string[] = [];

  add(
    childId: string,
    runId: string,
    name: string,
    status: ChildStatus,
    opts: { failSteer?: boolean } = {},
  ): HandleCalls {
    const calls: HandleCalls = { steer: [], followUp: [], resume: [] };
    this.calls.set(childId, calls);
    this.children.set(childId, {
      handle: fakeHandle(childId, calls, opts.failSteer),
      runId,
      name,
      status,
    });
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
  notifySupervisor(wake: { content: string }) {
    this.notifications.push(wake.content);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

describe("contactSupervisor", () => {
  it("need_decision blocks until reply() resolves it with the reply text", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    let settled = false;
    const p = comms
      .contactSupervisor("ch_a", "need_decision", "Which file should I modify?")
      .then((r) => {
        settled = true;
        return r;
      });

    // parent was notified with a supervisor-request that explains how to reply
    expect(host.notifications).toHaveLength(1);
    const note = host.notifications[0];
    expect(note).toContain('<pbs-wake kind="supervisor-request" from="ch_a" name="explorer">');
    expect(note).toContain("<message>Which file should I modify?</message>");
    expect(note).toContain('action: "reply"');
    expect(note).toContain("</pbs-wake>");

    await tick();
    expect(settled).toBe(false); // blocked

    comms.reply("ch_a", "src/index.ts");
    await expect(p).resolves.toBe("src/index.ts");
    expect(settled).toBe(true);
  });

  it("need_decision times out after the injected timeout with the contract message", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host, { decisionTimeoutMs: 20 });

    const p = comms.contactSupervisor("ch_a", "need_decision", "quick question");
    await expect(p).resolves.toBe(DECISION_TIMEOUT_MESSAGE);
    expect(comms.pendingRequests()).toEqual([]);
  });

  it("concurrent need_decision from multiple children do not interfere", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "aaa", "running");
    host.add("ch_b", "run_1", "bbb", "running");
    const comms = createComms(host);

    const pa = comms.contactSupervisor("ch_a", "need_decision", "question A");
    const pb = comms.contactSupervisor("ch_b", "need_decision", "question B");
    expect(host.notifications).toHaveLength(2);
    expect(comms.pendingRequests().map((r) => r.childId)).toEqual(["ch_a", "ch_b"]);

    comms.reply("ch_b", "answer B");
    await expect(pb).resolves.toBe("answer B");
    // ch_a still waiting, unaffected
    expect(comms.pendingRequests().map((r) => r.childId)).toEqual(["ch_a"]);

    comms.reply("ch_a", "answer A");
    await expect(pa).resolves.toBe("answer A");
    expect(comms.pendingRequests()).toEqual([]);
  });

  it("progress_update notifies immediately and returns ok without a waiter", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    const r = await comms.contactSupervisor("ch_a", "progress_update", "50% done");
    expect(r).toBe("ok");
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]).toContain('<pbs-wake kind="supervisor-update" from="ch_a" name="explorer">');
    expect(host.notifications[0]).toContain("50% done");
    expect(comms.pendingRequests()).toEqual([]);
  });

  it("writes both kinds to the mailbox; need_decision records the reply", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await comms.contactSupervisor("ch_a", "progress_update", "note");
    const p = comms.contactSupervisor("ch_a", "need_decision", "q");
    comms.reply("ch_a", "r");
    await p;

    const log = comms.log("run_1");
    expect(log.map((e) => e.kind)).toEqual(["progress_update", "need_decision", "reply"]);
    expect(log[0]).toMatchObject({ from: "ch_a", to: "supervisor", message: "note" });
    expect(log[1]).toMatchObject({ from: "ch_a", to: "supervisor", reply: "r" });
    expect(log[2]).toMatchObject({ from: "supervisor", to: "ch_a", message: "r" });
  });
});

describe("reply", () => {
  it("throws when there is no pending waiter and lists current pending requests", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "aaa", "running");
    host.add("ch_b", "run_1", "bbb", "running");
    const comms = createComms(host);

    void comms.contactSupervisor("ch_b", "need_decision", "pending question");
    await tick();

    expect(() => comms.reply("ch_a", "hello")).toThrow(
      /No pending decision request from ch_a\. Pending requests: ch_b \(bbb\)/,
    );

    // and with nothing pending at all
    const host2 = new FakeHost();
    const comms2 = createComms(host2);
    expect(() => comms2.reply("ch_x", "hi")).toThrow(/Pending requests: none/);
  });
});

describe("send", () => {
  it("running child + steer delivery calls handle.steer", async () => {
    const host = new FakeHost();
    const calls = host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await comms.send("ch_a", "focus on src/", "steer");
    expect(calls.steer).toEqual(["focus on src/"]);
    expect(calls.followUp).toEqual([]);
    expect(calls.resume).toEqual([]);
  });

  it("running child + queue delivery calls handle.followUp", async () => {
    const host = new FakeHost();
    const calls = host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await comms.send("ch_a", "when done, also check tests", "queue");
    expect(calls.followUp).toEqual(["when done, also check tests"]);
    expect(calls.steer).toEqual([]);
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "terminal (%s) child is not resumed; the error points at subagent resume",
    async (status) => {
      const host = new FakeHost();
      const calls = host.add("ch_a", "run_1", "explorer", status);
      const comms = createComms(host);

      await expect(comms.send("ch_a", "one more thing", "steer")).rejects.toThrow(
        /subagent\(\{ action: "resume", run_id: "run_1", child_id: "ch_a"/,
      );
      expect(calls.resume).toEqual([]);
      expect(calls.steer).toEqual([]);
    },
  );

  it("unknown child throws and lists known children", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await expect(comms.send("ch_zzz", "hi", "steer")).rejects.toThrow(
      /Unknown child "ch_zzz"\. Known children: ch_a \(explorer\)/,
    );
  });

  it("pending (not started) child throws a clear error", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "pending");
    const comms = createComms(host);

    await expect(comms.send("ch_a", "hi", "steer")).rejects.toThrow(/is pending/);
  });

  it("writes the send to the target run's mailbox", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await comms.send("ch_a", "hello", "steer");
    const log = comms.log("run_1");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      from: "supervisor",
      to: "ch_a",
      kind: "send",
      message: "hello",
    });
  });
});

describe("broadcast", () => {
  it("steers only running children of the same run", async () => {
    const host = new FakeHost();
    const a = host.add("ch_a", "run_1", "aaa", "running");
    const b = host.add("ch_b", "run_1", "bbb", "running");
    const c = host.add("ch_c", "run_1", "ccc", "completed");
    const d = host.add("ch_d", "run_2", "ddd", "running");
    const comms = createComms(host);

    const delivered = await comms.broadcast("run_1", "stop using /tmp");
    expect(delivered).toEqual(["ch_a", "ch_b"]);
    expect(a.steer).toEqual(["stop using /tmp"]);
    expect(b.steer).toEqual(["stop using /tmp"]);
    expect(c.steer).toEqual([]); // terminal
    expect(c.resume).toEqual([]); // broadcast never resumes
    expect(d.steer).toEqual([]); // other run
  });

  it("excludes the sender child itself", async () => {
    const host = new FakeHost();
    const a = host.add("ch_a", "run_1", "aaa", "running");
    const b = host.add("ch_b", "run_1", "bbb", "running");
    const comms = createComms(host);

    const delivered = await comms.broadcast("run_1", "heads up", "ch_a");
    expect(delivered).toEqual(["ch_b"]);
    expect(a.steer).toEqual([]);
    expect(b.steer).toEqual(["heads up"]);
  });

  it("is best-effort: a failing steer is skipped, others still receive it", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "aaa", "running", { failSteer: true });
    const b = host.add("ch_b", "run_1", "bbb", "running");
    const comms = createComms(host);

    const delivered = await comms.broadcast("run_1", "ping");
    expect(delivered).toEqual(["ch_b"]);
    expect(b.steer).toEqual(["ping"]);
    // only the successful delivery is logged
    expect(comms.log("run_1").map((e) => e.to)).toEqual(["ch_b"]);
  });

  it("logs broadcast entries with the sender as from", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "aaa", "running");
    host.add("ch_b", "run_1", "bbb", "running");
    const comms = createComms(host);

    await comms.broadcast("run_1", "msg", "ch_a");
    const log = comms.log("run_1");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from: "ch_a", to: "ch_b", kind: "broadcast" });
  });
});

describe("XML escaping", () => {
  it("escapes & < > \" in message and attributes", () => {
    const xml = formatSupervisorRequest(
      { childId: "ch_a", name: 'evil"<name>&' },
      'use <tag> & "quotes"',
    ).content;
    expect(xml).toContain('name="evil&quot;&lt;name&gt;&amp;"');
    expect(xml).toContain('use &lt;tag&gt; &amp; "quotes"');
    expect(xml).not.toContain('"<name>');
  });

  it("escapes progress_update payloads end-to-end", async () => {
    const host = new FakeHost();
    host.add("ch_a", "run_1", "explorer", "running");
    const comms = createComms(host);

    await comms.contactSupervisor("ch_a", "progress_update", 'found <script> & "x"');
    const note = host.notifications[0];
    expect(note).toContain('found &lt;script&gt; &amp; "x"');
    expect(note).not.toContain("<script>");
  });
});
