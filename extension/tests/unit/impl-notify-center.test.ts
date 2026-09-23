import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { NotifyCenter } from "../../src/notify";
import { PBS_WAKE_CUSTOM_TYPE, type PbsWake } from "../../src/wake";

describe("NotifyCenter monitor batching", () => {
  it("coalesces busy monitor output per monitor and flushes one wake when idle", () => {
    let idle = false;
    const sent: { message: { customType: string; content: string; details?: unknown }; options: unknown }[] = [];
    const center = new NotifyCenter({
      sendMessage: (message, options) => sent.push({ message, options }),
      isIdle: () => idle,
      clock: new ManualClock(),
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
