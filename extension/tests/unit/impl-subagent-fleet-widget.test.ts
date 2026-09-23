import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { FleetWidget, FLEET_WIDGET_KEY, summaryLabel, type FleetUi } from "../../src/subagent/fleet-widget";
import { WorkIndex } from "../../src/work-index";

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

function lastFactory(ui: ReturnType<typeof fakeUi>): ((w: number) => string[]) | undefined {
  for (let i = ui.widgets.length - 1; i >= 0; i--) {
    const c = ui.widgets[i];
    if (c.kind === "factory") return c.render;
    if (c.kind === "clear") return undefined;
  }
  return undefined;
}

describe("FleetWidget", () => {

  it("shows workers, subagents, and monitors without a total", () => {
    const ui = fakeUi();
    const clock = new ManualClock(10_000);
    const index = new WorkIndex({ clock });
    index.upsert({ id: "sh_1", kind: "shell", status: "running", title: "sleep 9", startedAt: 1, countsAsWorker: true });
    index.upsert({ id: "mon_1", kind: "monitor", status: "running", title: "ticker", startedAt: 2, countsAsWorker: false });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "worker-1 (worker)", startedAt: 3, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    const lines = lastFactory(ui)!(80);
    expect(lines[0]).toMatch(/1 worker/);
    expect(lines[0]).toMatch(/1 monitor/);
    expect(lines[1]).toContain("● worker-1 (worker) — 10s");
    expect(lines.join("\n")).not.toMatch(/\d+ tasks/);
    expect(summaryLabel(1, 1, 1)).toBe("1 worker · 1 subagent · 1 monitor");
    widget.dispose();
  });

  it("does not count a sync-waited shell as a worker", () => {
    const ui = fakeUi();
    const index = new WorkIndex();
    // Sync-waited shells are never inserted. A non-worker shell must not count.
    index.upsert({ id: "sh_fg", kind: "shell", status: "running", title: "echo hi", startedAt: 1, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui });
    widget.start();
    expect(lastFactory(ui)).toBeUndefined();
    widget.dispose();
  });

  it("clears the line when nothing is running", () => {
    const ui = fakeUi();
    const index = new WorkIndex();
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "a", startedAt: 1, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui });
    widget.start();
    expect(lastFactory(ui)).toBeDefined();
    index.patch("ch_1", { status: "completed", endedAt: 2 });
    expect(ui.widgets.at(-1)).toEqual({ kind: "clear" });
    widget.dispose();
  });

  it("refreshes live subagent ages on the shared clock", () => {
    const ui = fakeUi();
    const clock = new ManualClock(1_000);
    const index = new WorkIndex({ clock });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "alpha (worker)", startedAt: 0, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    expect(lastFactory(ui)?.(80).join("\n")).toContain("1s");
    const renders = ui.renders;
    clock.advanceBy(5000);
    expect(ui.renders).toBeGreaterThan(renders);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("6s");
    widget.dispose();
  });

  it("exports the widget key", () => {
    expect(FLEET_WIDGET_KEY).toBe("pbs-fleet");
  });
});
