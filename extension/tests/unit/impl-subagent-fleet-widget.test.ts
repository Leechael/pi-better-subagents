import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FleetWidget,
  FLEET_STATUS_KEY,
  FLEET_WIDGET_KEY,
  type FleetUi,
} from "../../src/subagent/fleet-widget";
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
  statuses: Array<string | undefined>;
  renders: number;
  editorText: string;
} {
  const state = {
    widgets: [] as WidgetCall[],
    statuses: [] as Array<string | undefined>,
    renders: 0,
    editorText: "",
    tui: { requestRender: () => { state.renders += 1; } },
    theme: {
      fg: (_c: string, t: string) => t,
    },
  };
  return {
    get widgets() { return state.widgets; },
    get statuses() { return state.statuses; },
    get renders() { return state.renders; },
    get editorText() { return state.editorText; },
    set editorText(v: string) { state.editorText = v; },
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
    setStatus(_key, text) {
      state.statuses.push(text);
    },
    getEditorText: () => state.editorText,
  };
}

function makeStack(ui: FleetUi, monitors: { taskId: string; description: string; startedAt: number }[] = []) {
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
      listShells: () => [],
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

describe("FleetWidget (Claude-style status)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a collapsed summary and footer status while agents run", async () => {
    const ui = fakeUi();
    const { registry, factory, widget } = makeStack(ui);
    widget.start();

    const run = registry.createRun("tasks");
    await registry.startChild(addReq(registry, run.runId, "worker-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(ui.statuses.at(-1)).toMatch(/1 agent/);
    const render = lastFactory(ui);
    expect(render).toBeDefined();
    const lines = render!(80);
    expect(lines[0]).toMatch(/1 agent/);
    expect(lines[0]).toMatch(/↓ to manage/);

    factory.sessions[0].complete("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.widgets.at(-1)).toEqual({ kind: "clear" });
    expect(ui.statuses.at(-1)).toBeUndefined();
    widget.dispose();
  });

  it("includes monitors in the collapsed summary", async () => {
    const ui = fakeUi();
    const monitors = [{ taskId: "mon_1", description: "ticker", startedAt: Date.now() }];
    const { widget } = makeStack(ui, monitors);
    widget.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.statuses.at(-1)).toMatch(/1 monitor/);
    const lines = lastFactory(ui)!(80);
    expect(lines[0]).toMatch(/monitor/);
    widget.dispose();
  });

  it("expands on ↓ when the editor is empty and collapses on esc", async () => {
    const ui = fakeUi();
    const handlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
    ui.onTerminalInput = (h) => {
      handlers.push(h);
      return () => {};
    };
    const { registry, factory, widget } = makeStack(ui);
    widget.start();
    const run = registry.createRun("tasks");
    await registry.startChild(addReq(registry, run.runId, "alpha"));
    await registry.startChild(addReq(registry, run.runId, "beta"));
    await vi.advanceTimersByTimeAsync(0);

    expect(handlers.length).toBe(1);
    const consumed = handlers[0]("\x1b[B"); // down
    expect(consumed?.consume).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    // Force a render after expand
    widget.refresh();
    const expanded = lastFactory(ui)!(80);
    expect(expanded.some((l) => l.includes("select"))).toBe(true);
    expect(expanded.some((l) => l.includes("alpha"))).toBe(true);

    handlers[0]("\x1b"); // escape
    widget.refresh();
    const collapsed = lastFactory(ui)!(80);
    expect(collapsed[0]).toMatch(/↓ to manage/);

    factory.sessions[0].complete("a");
    factory.sessions[1].complete("b");
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

  it("exports the contractual widget/status keys", () => {
    expect(FLEET_WIDGET_KEY).toBe("pbs-fleet");
    expect(FLEET_STATUS_KEY).toBe("pbs-fleet");
  });
});
