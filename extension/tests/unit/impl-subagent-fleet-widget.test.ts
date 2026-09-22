import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetWidget, FLEET_WIDGET_KEY, type FleetUi } from "../../src/subagent/fleet-widget";
import { SubagentRegistry } from "../../src/subagent/registry";
import { InProcessRunner } from "../../src/subagent/runner";
import type { ChildRunRequest } from "../../src/subagent/types";
import { SessionFactory, WORKER_AGENT } from "./subagent-fakes";

type WidgetCall =
  | { kind: "clear" }
  | { kind: "factory"; render: (width: number) => string[] }
  | { kind: "lines"; lines: string[] };

function fakeUi(): FleetUi & {
  widgets: WidgetCall[];
  renders: number;
} {
  const state = {
    widgets: [] as WidgetCall[],
    renders: 0,
    tui: { requestRender: () => { state.renders += 1; } },
    theme: {
      fg: (_c: string, t: string) => t,
    },
  };
  return {
    get widgets() { return state.widgets; },
    get renders() { return state.renders; },
    setWidget(_key, content) {
      if (content === undefined) {
        state.widgets.push({ kind: "clear" });
        return;
      }
      if (typeof content === "function") {
        const component = content(state.tui, state.theme);
        state.widgets.push({ kind: "factory", render: (w) => component.render(w) });
        return;
      }
      state.widgets.push({ kind: "lines", lines: content });
    },
  };
}

function makeStack(
  ui: FleetUi,
  monitors: { taskId: string; description: string; startedAt: number }[] = [],
  shells: { taskId: string; command: string; startedAt: number }[] = [],
) {
  const registry = new SubagentRegistry();
  const factory = new SessionFactory();
  factory.autoComplete = null;
  const runner = new InProcessRunner({
    createSession: factory.fn,
    acquire: (req) => registry.admitChild(req.childId),
  });
  registry.setRunner(runner);
  const widget = new FleetWidget({
    source: {
      onTransition: (cb) => registry.onTransition(cb),
      activeChildren: () => registry.activeChildren(),
      listMonitors: () => monitors,
      listShells: () => shells,
    },
    getUi: () => ui,
    refreshMs: 500,
  });
  return { registry, factory, widget };
}

function addReq(registry: SubagentRegistry, runId: string, name: string): ChildRunRequest {
  const childId = registry.addChild(runId, { name, agent: "worker" });
  return {
    childId,
    runId,
    name,
    prompt: `do ${name}`,
    agent: WORKER_AGENT,
    timeoutMs: 60_000,
    depth: 1,
  };
}

function lastFactory(ui: ReturnType<typeof fakeUi>): ((w: number) => string[]) | undefined {
  for (let i = ui.widgets.length - 1; i >= 0; i--) {
    const c = ui.widgets[i];
    if (c.kind === "factory") return c.render;
    if (c.kind === "clear") return undefined;
  }
  return undefined;
}

describe("FleetWidget (passive counts)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows worker, subagent, monitor, and total counts under the editor", async () => {
    const ui = fakeUi();
    const monitors = [{ taskId: "mon_1", description: "ticker", startedAt: Date.now() }];
    const shells = [{ taskId: "sh_1", command: "sleep 9", startedAt: Date.now() }];
    const { registry, factory, widget } = makeStack(ui, monitors, shells);
    widget.start();

    const run = registry.createRun("tasks");
    await registry.startChild(addReq(registry, run.runId, "worker-1"));
    await vi.advanceTimersByTimeAsync(0);

    const lines = lastFactory(ui)!(80);
    expect(lines[0]).toMatch(/1 worker/);
    expect(lines[0]).toMatch(/1 subagent/);
    expect(lines[0]).toMatch(/1 monitor/);
    expect(lines[0]).toMatch(/3 tasks/);
    expect(lines[0]).not.toMatch(/↓/);

    factory.sessions[0].complete("done");
    await vi.advanceTimersByTimeAsync(0);
    // Shell and monitor remain, so the line stays.
    const still = lastFactory(ui)!(80);
    expect(still[0]).toMatch(/1 worker/);
    expect(still[0]).not.toMatch(/subagent/);
    expect(still[0]).toMatch(/2 tasks/);
    widget.dispose();
  });

  it("clears the line when nothing is running", async () => {
    const ui = fakeUi();
    const { registry, factory, widget } = makeStack(ui);
    widget.start();
    const run = registry.createRun("tasks");
    await registry.startChild(addReq(registry, run.runId, "worker-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFactory(ui)).toBeDefined();

    factory.sessions[0].complete("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.widgets.at(-1)).toEqual({ kind: "clear" });
    widget.dispose();
  });

  it("re-renders on the 500ms tick while running", async () => {
    const ui = fakeUi();
    const { registry, factory, widget } = makeStack(ui);
    widget.start();
    const run = registry.createRun("tasks");
    await registry.startChild(addReq(registry, run.runId, "worker-1"));
    await vi.advanceTimersByTimeAsync(0);
    const before = ui.renders;
    await vi.advanceTimersByTimeAsync(500);
    expect(ui.renders).toBeGreaterThan(before);
    factory.sessions[0].complete("done");
    widget.dispose();
  });

  it("exports the widget key", () => {
    expect(FLEET_WIDGET_KEY).toBe("pbs-fleet");
  });
});
