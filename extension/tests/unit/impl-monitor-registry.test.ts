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

describe("MonitorRegistry early exit (manual testing, 2026-09-24)", () => {
  function setup(opts: { list?: () => unknown[] } = {}) {
    const clock = new ManualClock();
    const sent: { details?: unknown }[] = [];
    const exited: string[] = [];
    let registry!: MonitorRegistry;
    const manager = {
      ensureAvailable: async () => true,
      isAvailable: () => true,
      // `echo noop`: its line and exit share the socket read with the start
      // response, so they are dispatched before start() sees the task id.
      start: async () => {
        registry.handleOutput("mon_fast", "noop\n");
        registry.handleExit("mon_fast", { event: "task_exited", task_id: "mon_fast", exit_code: 0, duration_ms: 4 });
        return { task_id: "mon_fast", pid: 1 };
      },
      watch: async () => {},
      stop: async () => {},
      list: async () => opts.list?.() ?? [],
    } as unknown as ManagerClient;
    const center = new NotifyCenter({ sendMessage: (m) => sent.push(m), isIdle: () => true, clock });
    registry = new MonitorRegistry({
      getClient: () => manager,
      sessionEnv: () => ({}),
      getNotifyCenter: () => center,
      trackTask: () => {},
      clock,
      onExited: (id) => exited.push(id),
    });
    const wakes = () => sent.map((m) => m.details as PbsWake | undefined).filter((d) => d?.kind === "monitor");
    return { clock, registry, center, exited, wakes };
  }

  it("an exit that beats registration still ends the monitor, with its output", async () => {
    const { clock, registry, center, exited, wakes } = setup();
    await registry.start({ command: "echo noop", description: "noop" }, { cwd: "/tmp" } as ExtensionContext);
    clock.advanceBy(1_000);
    expect(registry.has("mon_fast")).toBe(false);
    expect(registry.listActive()).toEqual([]);
    expect(exited).toEqual(["mon_fast"]);
    const statuses = wakes().map((w) => (w as { status?: string }).status);
    expect(statuses).toContain("exited");
    expect(JSON.stringify(wakes())).toContain("noop");
    clock.advanceBy(400_000); // past the default timeout: no false "timed out"
    expect(wakes().map((w) => (w as { status?: string }).status)).not.toContain("timeout");
    center.dispose();
    registry.disposeAll();
  });

  it("reconcile closes a monitor the manager reports as ended", async () => {
    const { registry, center, exited } = setup();
    (registry as unknown as { deps: { getClient: () => ManagerClient } }).deps.getClient().start = (async () => ({ task_id: "mon_fast", pid: 1 })) as never;
    await registry.start({ command: "tail -f x", description: "tail" }, { cwd: "/tmp" } as ExtensionContext);
    const record = { task_id: "mon_fast", session_id: "s", kind: "monitor", command: "tail -f x", cwd: "/tmp", pid: 1, status: "running", exit_code: null, signal: null, started_at: 0, ended_at: null, output_path: "/o", output_size: 0 };
    expect(registry.reconcile([record])).toEqual([]);
    expect(registry.has("mon_fast")).toBe(true);
    expect(registry.reconcile([{ ...record, status: "completed", exit_code: 0, ended_at: 10 }])).toEqual(["mon_fast"]);
    expect(registry.has("mon_fast")).toBe(false);
    expect(exited).toEqual(["mon_fast"]);
    center.dispose();
    registry.disposeAll();
  });

  it("a monitor that timed out after its exit was lost is settled in the index (the stuck '2 monitors')", async () => {
    const { WorkIndex } = await import("../../src/work-index");
    const { exitEventFromRecord } = await import("../../src/monitor");
    const clock = new ManualClock(0);
    const index = new WorkIndex({ clock });
    // task_started created the row; the exit event never arrived.
    index.upsert({ id: "mon_f87f7957", kind: "monitor", status: "running", title: "echo noop", startedAt: 0, countsAsWorker: false });
    index.upsert({ id: "mon_live", kind: "monitor", status: "running", title: "tail -f", startedAt: 0, countsAsWorker: false });
    expect(index.counts().monitors).toBe(2);
    const tasks = [
      { task_id: "mon_f87f7957", status: "completed", exit_code: 0, signal: null, started_at: 0, ended_at: 6, output_path: "/o", session_id: "s", kind: "monitor", command: "echo noop", cwd: "/", pid: 1, output_size: 5 },
      { task_id: "mon_live", status: "running", exit_code: null, signal: null, started_at: 0, ended_at: null, output_path: "/o2", session_id: "s", kind: "monitor", command: "tail -f", cwd: "/", pid: 2, output_size: 0 },
    ];
    const stale = index.staleLive(tasks);
    expect(stale.map((t) => t.task_id)).toEqual(["mon_f87f7957"]);
    for (const t of stale) index.patch(t.task_id, { status: "completed", exitCode: exitEventFromRecord(t).exit_code ?? null, endedAt: 6 });
    expect(index.counts().monitors).toBe(1);
    expect(index.staleLive(tasks)).toEqual([]);
  });
});
