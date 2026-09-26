import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { formatMonitorEvent } from "../../src/format";
import { NotifyCenter } from "../../src/notify";
import { PBS_WAKE_CUSTOM_TYPE, type PbsWake } from "../../src/wake";

describe("NotifyCenter monitor batching", () => {
  it("coalesces busy monitor output per monitor and flushes one wake when idle", () => {
    let idle = false;
    const sent: { message: { customType: string; content: string; details?: unknown }; options: unknown }[] = [];
    const events: { type: string; fields?: Record<string, unknown> }[] = [];
    const center = new NotifyCenter({
      sendMessage: (message, options) => sent.push({ message, options }),
      isIdle: () => idle,
      clock: new ManualClock(),
      logEvent: (type, fields) => events.push({ type, fields }),
    });

    center.notifyMonitorEvent("ticker", "mon_1", "tick 1");
    center.notifyMonitorEvent("ticker", "mon_1", "tick 2", 3);
    center.notifyMonitorEvent("other", "mon_2", "ready");
    expect(sent).toHaveLength(0);

    idle = true;
    center.flushMonitorEvents();
    expect(sent).toHaveLength(2);
    const first = sent[0].message.details as PbsWake;
    expect(first).toMatchObject({
      kind: "monitor",
      id: "mon_1",
      event: "2 events · last: tick 2",
      eventCount: 2,
      droppedLines: 3,
    });
    expect(first.kind === "monitor" ? first.event : "").toBe("2 events · last: tick 2");
    expect(sent[0].message.customType).toBe(PBS_WAKE_CUSTOM_TYPE);
    expect(sent[0].options).toEqual({ triggerTurn: true });
    expect(sent[1].message.details).toMatchObject({ kind: "monitor", id: "mon_2", event: "ready" });
    expect(events).toContainEqual({ type: "wake.emit", fields: { kind: "monitor", ids: ["mon_1"], batch: true } });
    expect(events).toContainEqual({ type: "wake.deliver", fields: { kind: "monitor", mode: "trigger" } });
    center.dispose();
  });

  it("delivers a busy monitor's pending events before its exit notice", () => {
    // Seen in eval e2e (c2): `echo noop` exited while the agent was busy. The
    // exit notice went out at once, the coalesced "noop" only after the
    // agent settled, so the model heard "exited" before the line it printed.
    const sent: { message: { customType: string; content: string; details?: unknown }; options: unknown }[] = [];
    const center = new NotifyCenter({
      sendMessage: (message, options) => sent.push({ message, options }),
      isIdle: () => false,
      clock: new ManualClock(),
    });
    center.notifyMonitorEvent("watcher", "mon_1", "noop");
    center.notifyMonitorEvent("other", "mon_2", "still going");
    const exit = formatMonitorEvent("watcher", "mon_1", "Monitor process exited (exit code 0).", "exited");
    center.notify({ customType: exit.customType, content: exit.content, details: exit.details });
    expect(sent.map((s) => s.message.details)).toMatchObject([
      { kind: "monitor", id: "mon_1", event: "noop" },
      { kind: "monitor", id: "mon_1", status: "exited" },
    ]);
    expect(sent.every((s) => (s.options as { deliverAs?: string }).deliverAs === "steer")).toBe(true);
    // Another monitor's pending events keep waiting for the agent to settle.
    expect(sent.some((s) => (s.message.details as { id?: string }).id === "mon_2")).toBe(false);
    center.dispose();
  });

  it("logs task wake batches, delivery mode, and deduplicated exits", () => {
    const events: { type: string; fields?: Record<string, unknown> }[] = [];
    const center = new NotifyCenter({
      sendMessage: () => {},
      isIdle: () => false,
      clock: new ManualClock(),
      logEvent: (type, fields) => events.push({ type, fields }),
    });
    const exit = { taskId: "sh_1", kind: "shell", command: "true", status: "completed" as const, exitCode: 0, durationMs: 1, outputPath: "", preview: "" };
    center.notifyTaskExit(exit);
    center.notifyTaskExit(exit);
    center.flush();
    expect(events).toContainEqual({ type: "wake.dedupe", fields: { id: "sh_1" } });
    expect(events).toContainEqual({ type: "wake.emit", fields: { kind: "task", ids: ["sh_1"], batch: false } });
    expect(events).toContainEqual({ type: "wake.deliver", fields: { kind: "task", mode: "steer" } });
    center.dispose();
  });

  it("delivers immediately while idle and carries dropped-line metadata", () => {
    const sent: { message: { details?: unknown }; options: unknown }[] = [];
    const center = new NotifyCenter({
      sendMessage: (message, options) => sent.push({ message, options }),
      isIdle: () => true,
      clock: new ManualClock(),
    });
    center.notifyMonitorEvent("ticker", "mon_1", "tick", 2);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.details).toMatchObject({ kind: "monitor", event: "tick", droppedLines: 2 });
    center.dispose();
  });
});
