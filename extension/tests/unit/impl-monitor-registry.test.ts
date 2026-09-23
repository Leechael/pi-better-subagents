import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerClient } from "../../src/manager-client";
import { MonitorRegistry } from "../../src/monitor";
import { NotifyCenter } from "../../src/notify";
import type { PbsWake } from "../../src/wake";

describe("MonitorRegistry saturation", () => {
  it("stops on sustained drops even when accepted batches interrupt them", async () => {
    const clock = new ManualClock();
    const stopped: string[] = [];
    const sent: { details?: unknown }[] = [];
    const events: { type: string; fields?: Record<string, unknown> }[] = [];
    const manager = {
      ensureAvailable: async () => true,
      start: async () => ({ task_id: "mon_1", pid: 123 }),
      watch: async () => {},
      stop: async (taskId: string) => { stopped.push(taskId); },
    } as unknown as ManagerClient;
    const center = new NotifyCenter({
      sendMessage: (message) => sent.push(message),
      isIdle: () => true,
      clock,
    });
    const registry = new MonitorRegistry({
      getClient: () => manager,
      sessionEnv: () => ({}),
      getNotifyCenter: () => center,
      trackTask: () => {},
      clock,
      logEvent: (type, fields) => events.push({ type, fields }),
    });

    const { taskId } = await registry.start(
      { command: "ticker", description: "ticker", persistent: true },
      { cwd: "/tmp" } as ExtensionContext,
    );
    for (let i = 0; i < 151; i++) {
      registry.handleOutput(taskId, `line ${i}\n`);
      clock.advanceBy(200);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(stopped).toEqual(["mon_1"]);
    expect(registry.has("mon_1")).toBe(false);
    const stopWake = sent.map((item) => item.details as PbsWake | undefined).find(
      (details): details is Extract<PbsWake, { kind: "monitor" }> =>
        details?.kind === "monitor" && details.status === "stopped",
    );
    expect(stopWake?.droppedLines).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "monitor.drop" && event.fields?.id === "mon_1")).toBe(true);
    expect(events).toContainEqual({ type: "monitor.stop", fields: { id: "mon_1", reason: "rate-limit" } });
    center.dispose();
    registry.disposeAll();
  });
});
