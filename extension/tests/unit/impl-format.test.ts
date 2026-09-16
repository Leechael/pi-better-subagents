import { describe, expect, it } from "vitest";
import {
  formatBackgroundNotice,
  formatMonitorEvent,
  formatTaskNotification,
  truncateTail,
  type TaskExitInfo,
} from "../../src/format";

describe("truncateTail", () => {
  it("returns text unchanged when within both limits", () => {
    const res = truncateTail("a\nb\nc", 10, 1000);
    expect(res).toEqual({ text: "a\nb\nc", truncated: false, totalLines: 3, totalBytes: 5 });
  });

  it("keeps the tail when the line limit is exceeded", () => {
    const text = ["l1", "l2", "l3", "l4", "l5"].join("\n");
    const res = truncateTail(text, 3, 1000);
    expect(res.text).toBe("l3\nl4\nl5");
    expect(res.truncated).toBe(true);
    expect(res.totalLines).toBe(5);
  });

  it("keeps the tail when the byte limit is exceeded", () => {
    const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
    // 4 lines * 4 bytes + 3 newlines = 19 bytes; limit fits only the last line.
    const res = truncateTail(text, 100, 5);
    expect(res.text).toBe("dddd");
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBe(19);
  });

  it("keeps the byte tail of a single line that exceeds maxBytes", () => {
    const res = truncateTail("x".repeat(100), 10, 10);
    expect(res.text).toBe("x".repeat(10));
    expect(res.truncated).toBe(true);
    expect(res.totalLines).toBe(1);
    expect(res.totalBytes).toBe(100);
  });

  it("handles empty input", () => {
    const res = truncateTail("", 10, 10);
    expect(res).toEqual({ text: "", truncated: false, totalLines: 1, totalBytes: 0 });
  });

  it("uses the built-in defaults (2000 lines / 50KB)", () => {
    const manyLines = Array.from({ length: 3000 }, (_, i) => `line${i}`).join("\n");
    const res = truncateTail(manyLines);
    expect(res.truncated).toBe(true);
    expect(res.totalLines).toBe(3000);
    expect(res.text.split("\n")).toHaveLength(2000);
    expect(res.text.endsWith("line2999")).toBe(true);
    expect(res.text.startsWith("line1000\n")).toBe(true);
  });

  it("counts multi-byte characters in bytes, not chars", () => {
    const res = truncateTail("ééé", 10, 4); // each é is 2 bytes
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBe(6);
    expect(Buffer.byteLength(res.text, "utf8")).toBeLessThanOrEqual(4);
  });
});

function exitInfo(overrides: Partial<TaskExitInfo> = {}): TaskExitInfo {
  return {
    taskId: "sh_a1b2c3d4",
    kind: "shell",
    command: "npm test",
    status: "completed",
    exitCode: 0,
    durationMs: 12345,
    outputPath: "/home/u/.pi/agent/pbs/sessions/s/tasks/sh_a1b2c3d4.output",
    preview: "all tests passed",
    ...overrides,
  };
}

describe("formatTaskNotification", () => {
  it("matches the §4.5 XML layout for a single event", () => {
    const xml = formatTaskNotification([exitInfo()]);
    expect(xml).toContain("system wake");
    expect(xml).toContain("Handle each task-notification block");
    expect(xml).toContain(
      [
        "<task-notification>",
        "  <task-id>sh_a1b2c3d4</task-id><kind>shell</kind>",
        "  <status>completed</status>",
        '  <summary>Background command "npm test" completed (exit code 0)</summary>',
        "  <output-file>/home/u/.pi/agent/pbs/sessions/s/tasks/sh_a1b2c3d4.output</output-file>",
        "  <preview>all tests passed</preview>",
        "  <duration-ms>12345</duration-ms>",
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("merges multiple events into a list of notification blocks", () => {
    const xml = formatTaskNotification([
      exitInfo(),
      exitInfo({ taskId: "sh_deadbeef", status: "failed", exitCode: 1, command: "make" }),
    ]);
    expect(xml.match(/<task-notification>/g)).toHaveLength(2);
    expect(xml).toContain("<task-id>sh_deadbeef</task-id>");
    expect(xml).toContain("<status>failed</status>");
    expect(xml).toContain('Background command "make" failed (exit code 1)');
  });

  it("renders killed and orphaned statuses", () => {
    expect(formatTaskNotification([exitInfo({ status: "killed", exitCode: null })])).toContain(
      "was killed",
    );
    expect(formatTaskNotification([exitInfo({ status: "orphaned", exitCode: null })])).toContain(
      "<status>orphaned</status>",
    );
  });

  it("escapes XML in command and preview", () => {
    const xml = formatTaskNotification([
      exitInfo({ command: 'grep "<a>&" file', preview: "x < y & z > w" }),
    ]);
    expect(xml).toContain('grep "&lt;a&gt;&amp;" file');
    expect(xml).toContain("x &lt; y &amp; z &gt; w");
    expect(xml).not.toContain("x < y");
  });

  it("truncates very long commands in the summary", () => {
    const xml = formatTaskNotification([exitInfo({ command: `cmd ${"x".repeat(200)}` })]);
    expect(xml).toContain("…");
    expect(xml.length).toBeLessThan(1000);
  });
});

describe("formatBackgroundNotice", () => {
  it("contains task id, output path and the no-poll instruction", () => {
    const text = formatBackgroundNotice("sh_a1b2c3d4", "npm run build", "/tmp/out.log");
    expect(text).toContain("task_id: sh_a1b2c3d4");
    expect(text).toContain("Output: /tmp/out.log");
    expect(text).toContain("You will be notified when it completes. Do not poll or sleep");
    expect(text).toContain("<task-notification>");
    expect(text).toContain('"npm run build"');
  });
});

describe("formatMonitorEvent", () => {
  it("wraps the batch in a monitor-event element with attributes", () => {
    const text = formatMonitorEvent("watch tests", "mon_ab12", "line1\nline2");
    expect(text).toContain('<monitor-event description="watch tests" task_id="mon_ab12">');
    expect(text).toContain("system wake");
    expect(text).toContain('Monitor event (system wake — not a new user message): "watch tests"');
    expect(text).toContain("<event>\nline1\nline2\n</event>");
    expect(text).toContain("</monitor-event>");
  });

  it("escapes attribute values", () => {
    const text = formatMonitorEvent('a "b" <c>', "mon_x", "body");
    expect(text).toContain('description="a &quot;b&quot; &lt;c&gt;"');
  });
});
