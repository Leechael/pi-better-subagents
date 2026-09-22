import { afterEach, describe, expect, it } from "vitest";
import { createMonitorTool, MonitorRegistry } from "../../src/monitor";
import { TASK_NOTIFICATION_CUSTOM_TYPE } from "../../src/notify";
import { registerPbsMessageRenderers } from "../../src/tui/message-renderers";
import { setPiTuiForTests, visibleWidth } from "../../src/tui/pi-tui-load";

const theme = {
  fg: (color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
  bg: (_c: string, text: string) => text,
};

describe("tool rows stay within width without pi-tui", () => {
  afterEach(() => {
    setPiTuiForTests(undefined);
  });

  it("truncates a long monitor description when pi-tui cannot be resolved", () => {
    setPiTuiForTests(null);
    const tool = createMonitorTool(new MonitorRegistry({} as never));
    const desc = `watch ${"宽".repeat(40)} ${"x".repeat(80)}`;
    const component = tool.renderCall!({ command: "true", description: desc }, theme as never, {} as never) as {
      render: (width: number) => string[];
    };
    const lines = component.render(40);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.join("")).toContain("Monitor");
  });

  it("truncates a notification pill when pi-tui cannot be resolved", () => {
    setPiTuiForTests(null);
    const map = new Map<string, Function>();
    registerPbsMessageRenderers({
      registerMessageRenderer(type: string, fn: unknown) {
        map.set(type, fn as never);
      },
    } as never);
    const summary = `Background command "${"宽".repeat(30)}${"x".repeat(80)}" failed`;
    const component = map.get(TASK_NOTIFICATION_CUSTOM_TYPE)!(
      { content: `<task-notification><status>failed</status><summary>${summary}</summary></task-notification>` },
      { expanded: false, outputPad: 1 },
      theme,
    );
    const lines = component.render(40);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.join("")).toContain("✗");
    expect(lines.join("")).not.toContain("✓");
  });
});
