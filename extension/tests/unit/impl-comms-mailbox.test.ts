import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { DECISION_TIMEOUT_MESSAGE, Mailbox } from "../../src/comms/mailbox";

describe("Mailbox ring log", () => {
  it("keeps the last 200 entries per run (default capacity)", () => {
    const mb = new Mailbox();
    for (let i = 0; i < 250; i++) {
      mb.append("run_1", { from: "a", to: "b", kind: "send", message: `msg-${i}` });
    }
    const all = mb.log("run_1", 1000);
    expect(all).toHaveLength(200);
    expect(all[0].message).toBe("msg-50"); // oldest 50 dropped
    expect(all[199].message).toBe("msg-249");
  });

  it("rings are independent per run", () => {
    const mb = new Mailbox({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      mb.append("run_1", { from: "a", to: "b", kind: "send", message: `r1-${i}` });
    }
    mb.append("run_2", { from: "a", to: "b", kind: "send", message: "r2-0" });
    expect(mb.log("run_1", 10).map((e) => e.message)).toEqual(["r1-2", "r1-3", "r1-4"]);
    expect(mb.log("run_2", 10).map((e) => e.message)).toEqual(["r2-0"]);
  });

  it("log defaults to 20 entries and respects limit, chronological order", () => {
    const mb = new Mailbox();
    for (let i = 0; i < 30; i++) {
      mb.append("run_1", { from: "a", to: "b", kind: "send", message: `m${i}` });
    }
    expect(mb.log("run_1")).toHaveLength(20);
    expect(mb.log("run_1")[0].message).toBe("m10");
    const last3 = mb.log("run_1", 3);
    expect(last3.map((e) => e.message)).toEqual(["m27", "m28", "m29"]);
    expect(mb.log("unknown_run")).toEqual([]);
  });

  it("stamps ts from the injected clock and preserves explicit ts", () => {
    const clock = new ManualClock(42);
    const mb = new Mailbox({ clock });
    const stamped = mb.append("run_1", { from: "a", to: "b", kind: "send", message: "x" });
    expect(stamped.ts).toBe(42);
    const explicit = mb.append("run_1", {
      ts: 7,
      from: "a",
      to: "b",
      kind: "send",
      message: "y",
    });
    expect(explicit.ts).toBe(7);
  });
});

describe("Mailbox need_decision waiters", () => {
  it("resolveDecision resolves the waiter with the reply text", async () => {
    const mb = new Mailbox();
    const p = mb.beginDecision("ch_a", "explorer", "which file?");
    expect(mb.hasPendingDecision("ch_a")).toBe(true);
    expect(mb.resolveDecision("ch_a", "src/index.ts")).toBe(true);
    await expect(p).resolves.toBe("src/index.ts");
    expect(mb.hasPendingDecision("ch_a")).toBe(false);
  });

  it("resolveDecision returns false when nothing is pending", () => {
    const mb = new Mailbox();
    expect(mb.resolveDecision("ch_nope", "hi")).toBe(false);
  });

  it("times out with the contract message (fake clock)", async () => {
    const clock = new ManualClock();
    const mb = new Mailbox({ clock });
    const p = mb.beginDecision("ch_a", "explorer", "stuck");
    clock.advanceBy(599_999);
    expect(mb.hasPendingDecision("ch_a")).toBe(true);
    clock.advanceBy(1); // 10 minutes
    await expect(p).resolves.toBe(DECISION_TIMEOUT_MESSAGE);
    expect(mb.pendingRequests()).toEqual([]);
    // a late reply finds no waiter
    expect(mb.resolveDecision("ch_a", "too late")).toBe(false);
  });

  it("times out with a short injected timeout", async () => {
    const clock = new ManualClock();
    const mb = new Mailbox({ decisionTimeoutMs: 20, clock });
    const p = mb.beginDecision("ch_a", "explorer", "stuck");
    clock.advanceBy(20);
    await expect(p).resolves.toBe(DECISION_TIMEOUT_MESSAGE);
  });

  it("per-child waiters are independent (no global lock)", async () => {
    const clock = new ManualClock();
    const mb = new Mailbox({ clock });
    const pa = mb.beginDecision("ch_a", "aaa", "question A");
    const pb = mb.beginDecision("ch_b", "bbb", "question B");

    // resolving ch_a must not disturb ch_b
    expect(mb.resolveDecision("ch_a", "answer A")).toBe(true);
    await expect(pa).resolves.toBe("answer A");
    expect(mb.pendingRequests().map((r) => r.childId)).toEqual(["ch_b"]);

    // ch_b times out on its own timer
    clock.advanceBy(600_000);
    await expect(pb).resolves.toBe(DECISION_TIMEOUT_MESSAGE);
    expect(mb.pendingRequests()).toEqual([]);
  });

  it("rejects a second concurrent decision request from the same child", () => {
    const mb = new Mailbox();
    void mb.beginDecision("ch_a", "aaa", "first");
    expect(() => mb.beginDecision("ch_a", "aaa", "second")).toThrow(/already has a pending/);
  });

  it("pendingRequests reports childId, name, message and sinceMs", () => {
    const clock = new ManualClock(5_000);
    const mb = new Mailbox({ clock });
    void mb.beginDecision("ch_a", "explorer", "q1");
    clock.advanceBy(1_500);
    void mb.beginDecision("ch_b", "worker", "q2");
    expect(mb.pendingRequests()).toEqual([
      { childId: "ch_a", name: "explorer", message: "q1", sinceMs: 5_000 },
      { childId: "ch_b", name: "worker", message: "q2", sinceMs: 6_500 },
    ]);
  });

  it("a resolved waiter's timer is cancelled (no late timeout override)", async () => {
    const clock = new ManualClock();
    const mb = new Mailbox({ clock });
    const p = mb.beginDecision("ch_a", "aaa", "q");
    mb.resolveDecision("ch_a", "reply");
    clock.advanceBy(600_000); // would time out if the handle had not been cancelled
    await expect(p).resolves.toBe("reply");
  });

  it("dispose resolves outstanding waiters and clears timers", async () => {
    const clock = new ManualClock();
    const mb = new Mailbox({ clock });
    const p = mb.beginDecision("ch_a", "aaa", "q");
    mb.dispose();
    clock.advanceBy(600_000);
    await expect(p).resolves.toBe(DECISION_TIMEOUT_MESSAGE);
    expect(mb.pendingRequests()).toEqual([]);
  });
});
