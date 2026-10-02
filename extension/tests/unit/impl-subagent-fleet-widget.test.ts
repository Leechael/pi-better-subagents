import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { FleetWidget, FLEET_WIDGET_KEY, summaryLabel, type FleetUi } from "../../src/subagent/fleet-widget";
import { visibleWidth } from "../../src/tui/pi-tui-load";
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

  it("shows shells, monitors and named subagents on one line", () => {
    const ui = fakeUi();
    const clock = new ManualClock(10_000);
    const index = new WorkIndex({ clock });
    index.upsert({ id: "sh_1", kind: "shell", status: "running", title: "sleep 9", startedAt: 1, countsAsWorker: true });
    index.upsert({ id: "mon_1", kind: "monitor", status: "running", title: "ticker", startedAt: 2, countsAsWorker: false });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "worker-1 (worker)", name: "worker-1", startedAt: 3, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    const lines = lastFactory(ui)!(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("● 1 shell · 1 monitor · worker-1 10s");
    expect(lines[0]).toContain("/tasks");
    expect(lines.join("\n")).not.toMatch(/\d+ tasks|worker ·/);
    expect(summaryLabel(1, 1, 1)).toBe("1 shell · 1 subagent · 1 monitor");
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

  it("ticks exactly when a displayed age flips, per-item relative to startedAt", () => {
    const ui = fakeUi();
    // Start mid-second so the ticker must realign instead of inheriting phase.
    const clock = new ManualClock(1_300);
    const index = new WorkIndex({ clock });
    // startedAt 0: offset 1_300 → next flip at 1_500 ("1s" → "2s").
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "alpha (worker)", name: "alpha", startedAt: 0, countsAsWorker: false });
    // startedAt 400: offset 900 → next flip at 1_900 ("1s" → "2s"), a different phase.
    index.upsert({ id: "ch_2", kind: "agent", status: "running", title: "beta (worker)", name: "beta", startedAt: 400, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    // No render requested before the first boundary.
    expect(ui.renders).toBe(0);
    clock.advanceBy(199);
    expect(ui.renders).toBe(0);
    // alpha flips at 1_500 — exactly one render.
    clock.advanceBy(1);
    expect(ui.renders).toBe(1);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("alpha 2s");
    expect(lastFactory(ui)?.(80).join("\n")).toContain("beta 1s");
    // beta flips at 1_900 — its own phase, not the global one.
    clock.advanceBy(399);
    expect(ui.renders).toBe(1);
    clock.advanceBy(1);
    expect(ui.renders).toBe(2);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("beta 2s");
    // Both items keep flipping on their own cadence: alpha at 2_500 and 3_500,
    // beta at 2_900 and 3_900 — exactly one render per flip, none skipped.
    clock.advanceBy(600);
    expect(ui.renders).toBe(3);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("alpha 3s");
    clock.advanceBy(400);
    expect(ui.renders).toBe(4);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("beta 3s");
    clock.advanceBy(600);
    expect(ui.renders).toBe(5);
    expect(lastFactory(ui)?.(80).join("\n")).toContain("alpha 4s");
    widget.dispose();
  });

  it("counts only live work: finished or failed items drop out, and the line clears", () => {
    const ui = fakeUi();
    const clock = new ManualClock(1_000);
    const index = new WorkIndex({ clock });
    index.upsert({ id: "sh_1", kind: "shell", status: "running", title: "npm test", startedAt: 0, countsAsWorker: true });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "alpha (worker)", name: "alpha", startedAt: 0, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    index.patch("ch_1", { status: "failed", endedAt: 900, error: "boom" });
    const line = lastFactory(ui)?.(80).join("\n") ?? "";
    expect(line).toContain("1 shell");
    expect(line).not.toContain("alpha");
    expect(line).not.toMatch(/failed|✗/);
    index.patch("sh_1", { status: "killed", endedAt: 950 });
    expect(ui.widgets.at(-1)).toEqual({ kind: "clear" });
    widget.dispose();
  });

  it("never renders wider than the terminal, even below 20 columns", () => {
    const ui = fakeUi();
    const clock = new ManualClock(1_000);
    const index = new WorkIndex({ clock });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "a", name: "一个很长的子代理名字", startedAt: 0, countsAsWorker: false });
    const widget = new FleetWidget({ index, getUi: () => ui, clock });
    widget.start();
    for (const width of [8, 12, 40]) {
      for (const l of lastFactory(ui)!(width)) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
    }
    widget.dispose();
  });

  it("exports the widget key", () => {
    expect(FLEET_WIDGET_KEY).toBe("pi-famulus-fleet");
  });
});
