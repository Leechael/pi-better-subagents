import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import type { RunRecord } from "../../src/subagent/registry";
import { createSubagentTool } from "../../src/subagent/tool";
import { WorkIndex } from "../../src/work-index";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

describe("subagent transcript row", () => {
  it("shows one line per child for a backgrounded run and redraws as children finish", () => {
    const clock = new ManualClock(10_000);
    const index = new WorkIndex({ clock });
    const record: RunRecord = {
      runId: "run_1",
      kind: "tasks",
      status: "running",
      createdAt: 0,
      children: [
        { childId: "ch_a", name: "alpha", agent: "worker", status: "running", startedAt: 5_000 },
        { childId: "ch_b", name: "beta", agent: "worker", status: "failed", startedAt: 5_000, endedAt: 7_000, result: { status: "failed", text: "", error: "529 overloaded", durationMs: 2_000 } },
      ],
    };
    const tool = createSubagentTool({
      getRegistry: () => ({ get: () => record }) as never,
      getNotifyCenter: () => null,
      getIndex: () => index,
      budgetMs: () => 45_000,
      defaultTimeoutMs: 1_000,
      defaultConcurrency: 4,
      clock,
    });
    let invalidations = 0;
    const context = { state: {}, invalidate: () => invalidations++ };
    const result = {
      content: [{ type: "text", text: "Started 2 subagent(s) in run run_1. … Do not poll." }],
      details: { run_id: "run_1", status: "backgrounded" },
    };
    const render = () =>
      (tool.renderResult!(result as never, { expanded: false, isPartial: false }, theme, context as never) as unknown as {
        render(w: number): string[];
      }).render(80);

    const lines = render();
    expect(lines[0]).toBe("run run_1 · running · /tasks");
    expect(lines[1]).toBe("  ● alpha running 5.0s");
    expect(lines[2]).toBe("  ✗ beta failed 2.0s · 529 overloaded");
    expect(lines.join("\n")).not.toContain("Do not poll");

    index.upsert({ id: "ch_a", kind: "agent", status: "completed", title: "alpha", startedAt: 5_000, endedAt: 9_000, countsAsWorker: false });
    expect(invalidations).toBeGreaterThan(0);
  });
});
