import { describe, expect, it } from "vitest";
import { createMonitorTool, MonitorRegistry } from "../../src/monitor";

describe("monitor tool result rendering", () => {
  it("renders failed tool results as failures and avoids key-hint glyphs", () => {
    const registry = new MonitorRegistry({
      getClient: () => null,
      sessionEnv: () => ({}),
      getNotifyCenter: () => null,
      trackTask: () => {},
    });
    const tool = createMonitorTool(registry);
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    };
    const result = (tool.renderResult as Function)(
      { isError: true, content: [{ type: "text", text: "pbs-manager is not available" }] },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    ) as { render(width: number): string[] };
    const text = result.render(120).join("\n");
    expect(text).toContain("✗");
    expect(text).not.toContain("✓");
    expect(text).toContain("manage via /tasks");
    expect(text).not.toContain("↓");
  });
});
