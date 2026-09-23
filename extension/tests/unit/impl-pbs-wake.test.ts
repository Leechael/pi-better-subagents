import { describe, expect, it } from "vitest";
import { formatSupervisorRequest } from "../../src/comms/comms";
import {
  formatMonitorEvent,
  formatSubagentHandover,
  formatSubagentNotification,
  formatTaskNotification,
  type TaskExitInfo,
} from "../../src/format";
import { formatPbsWake, PBS_WAKE_CUSTOM_TYPE, PBS_WAKE_LEAD_IN } from "../../src/wake";
import { registerPbsMessageRenderers } from "../../src/tui/message-renderers";
import { setPiTuiForTests, visibleWidth } from "../../src/tui/pi-tui-load";

describe("pbs-wake envelope", () => {
  it("wraps a task batch in one envelope and keeps a comma inside an item title", () => {
    const wake = formatPbsWake({
      kind: "task",
      stillRunning: [{ id: "sh_other", title: "npm test, coverage" }],
      tasks: [
        {
          id: "sh_a1b2c3d4",
          taskKind: "shell",
          status: "completed",
          summary: 'Background command "npm test" completed (exit code 0)',
          command: "npm test",
          outputPath: "/tmp/sh_a1b2c3d4.output",
          preview: "all tests passed",
          durationMs: 12345,
          exitCode: 0,
        },
        {
          id: "sh_dead",
          taskKind: "shell",
          status: "failed",
          summary: 'Background command "make" failed (exit code 1)',
          command: "make",
          outputPath: "/tmp/sh_dead.output",
          preview: "",
          durationMs: 12345,
          exitCode: 1,
        },
      ],
    });
    expect(wake.customType).toBe(PBS_WAKE_CUSTOM_TYPE);
    expect(wake.content.startsWith(PBS_WAKE_LEAD_IN)).toBe(true);
    expect(wake.content.match(/<pbs-wake /g)).toHaveLength(1);
    expect(wake.content).toContain('<pbs-wake kind="task">');
    expect(wake.content).toContain('<item id="sh_other">npm test, coverage</item>');
    expect(wake.content).not.toContain("<still-running>npm test, coverage");
    expect(wake.content).toContain(
      '<task id="sh_a1b2c3d4" kind="shell" status="completed" duration-ms="12345" exit-code="0">',
    );
    expect(wake.content).toContain('<task id="sh_dead" kind="shell" status="failed" duration-ms="12345" exit-code="1">');
    expect(wake.details.kind).toBe("task");
  });

  it("omits still-running and exit-code when empty or null, and keeps signal as a name", () => {
    const wake = formatPbsWake({
      kind: "task",
      stillRunning: [],
      tasks: [
        {
          id: "sh_killed",
          taskKind: "shell",
          status: "killed",
          summary: 'Background command "npm test" was killed',
          command: "npm test",
          outputPath: "/tmp/x",
          preview: "",
          durationMs: 10,
          exitCode: null,
          signal: "SIGTERM",
        },
      ],
    });
    expect(wake.content).not.toContain("<still-running>");
    expect(wake.content).not.toContain("exit-code");
    expect(wake.content).toContain('signal="SIGTERM"');
    if (wake.details.kind !== "task") throw new Error("kind");
    expect(wake.details.tasks[0].exitCode).toBeNull();
    expect(wake.details.tasks[0].signal).toBe("SIGTERM");
  });

  it("still parses when the lead-in is ablated to empty", () => {
    const wake = formatPbsWake(
      {
        kind: "task",
        stillRunning: [],
        tasks: [
          {
            id: "sh_1",
            taskKind: "shell",
            status: "completed",
            summary: "done",
            command: "true",
            outputPath: "/tmp/x",
            preview: "",
            durationMs: 1,
            exitCode: 0,
          },
        ],
      },
      "",
    );
    expect(wake.content.startsWith("<pbs-wake ")).toBe(true);
    expect(wake.content).not.toContain(PBS_WAKE_LEAD_IN);
  });

  it("escapes a monitor event body, including a fake closing tag", () => {
    const wake = formatPbsWake({
      kind: "monitor",
      id: "mon_1",
      description: "watch <tests>",
      status: "exited",
      event: "line <a>\n</event>\nline2",
    });
    expect(wake.content).toContain(
      '<pbs-wake kind="monitor" id="mon_1" description="watch &lt;tests&gt;" status="exited">',
    );
    expect(wake.content).toContain("<event>line &lt;a&gt;\n&lt;/event&gt;\nline2</event>");
    expect(wake.content).not.toContain("<event>line <a>");
    expect(wake.details).toMatchObject({ kind: "monitor", event: "line <a>\n</event>\nline2" });
  });

  it("emits subagent-done as one child element per child", () => {
    const wake = formatPbsWake({
      kind: "subagent-done",
      runId: "run_a",
      status: "partial",
      durationMs: 100,
      summary: "1/2 subagents completed in 100ms",
      children: [
        { childId: "ch_1", name: "a", status: "completed", prompt: "look", result: "ok" },
        { childId: "ch_2", name: "b", status: "failed", prompt: "fix", result: "", error: "boom" },
      ],
    });
    expect(wake.content).toContain(
      '<pbs-wake kind="subagent-done" run-id="run_a" status="partial" duration-ms="100">',
    );
    expect(wake.content).toContain('<child id="ch_2" name="b" status="failed">');
    expect(wake.content).toContain("<error>boom</error>");
    expect(wake.content).toContain("<prompt>look</prompt>");
    expect(wake.details).toMatchObject({
      kind: "subagent-done",
      children: [
        { childId: "ch_1", prompt: "look", result: "ok" },
        { childId: "ch_2", error: "boom" },
      ],
    });
  });

  it("puts handover still-running titles in item elements", () => {
    const wake = formatPbsWake({
      kind: "subagent-handover",
      runId: "run_a",
      childId: "ch_1",
      name: "worker-1",
      status: "completed",
      stillRunning: [{ id: "ch_2", title: "reviewer, slow" }],
      summary: "worker-1 completed; 1 still running",
      prompt: "inspect",
      result: "done",
    });
    expect(wake.content).toContain('kind="subagent-handover"');
    expect(wake.content).toContain('<item id="ch_2">reviewer, slow</item>');
    expect(wake.content).toContain("<prompt>inspect</prompt>");
    expect(wake.content).toContain("<result>done</result>");
  });

  it("puts the reply recipe in reply-with, not after the message", () => {
    const wake = formatPbsWake({
      kind: "supervisor-request",
      from: "ch_a",
      name: "explorer",
      message: "Which file?",
    });
    expect(wake.content).toContain('<pbs-wake kind="supervisor-request" from="ch_a" name="explorer">');
    expect(wake.content).toContain("<message>Which file?</message>");
    expect(wake.content).toContain(
      '<reply-with>agent_message { action: "reply", to: "ch_a", message: "&lt;your decision&gt;" }</reply-with>',
    );
    const message = wake.content.slice(wake.content.indexOf("<message>"), wake.content.indexOf("</message>"));
    expect(message).not.toContain("action:");
  });
});

const exit = (overrides: Partial<TaskExitInfo> = {}): TaskExitInfo => ({
  taskId: "sh_a1b2c3d4",
  kind: "shell",
  command: "npm test",
  status: "completed",
  exitCode: 0,
  durationMs: 12345,
  outputPath: "/tmp/sh_a1b2c3d4.output",
  preview: "all tests passed",
  ...overrides,
});

describe("pbs-wake envelope", () => {
  it("wraps a task batch in one envelope and keeps a comma inside an item title", () => {
    const wake = formatTaskNotification(
      [exit(), exit({ taskId: "sh_dead", status: "failed", exitCode: 1, command: "make" })],
      [{ id: "sh_other", title: "npm test, coverage" }],
    );
    expect(wake.customType).toBe(PBS_WAKE_CUSTOM_TYPE);
    expect(wake.content.startsWith(PBS_WAKE_LEAD_IN)).toBe(true);
    expect(wake.content.match(/<pbs-wake /g)).toHaveLength(1);
    expect(wake.content).toContain('<pbs-wake kind="task">');
    expect(wake.content).toContain('<item id="sh_other">npm test, coverage</item>');
    expect(wake.content).not.toContain("<still-running>npm test, coverage");
    expect(wake.content).toContain('<task id="sh_a1b2c3d4" kind="shell" status="completed" duration-ms="12345" exit-code="0">');
    expect(wake.content).toContain('<task id="sh_dead" kind="shell" status="failed" duration-ms="12345" exit-code="1">');
    expect(wake.details).toMatchObject({
      kind: "task",
      stillRunning: [{ id: "sh_other", title: "npm test, coverage" }],
      tasks: [
        { id: "sh_a1b2c3d4", exitCode: 0 },
        { id: "sh_dead", exitCode: 1, status: "failed" },
      ],
    });
  });

  it("omits still-running and exit-code when empty or null, and keeps signal as a name", () => {
    const wake = formatTaskNotification([
      exit({ status: "killed", exitCode: null, signal: "SIGTERM" }),
    ]);
    expect(wake.content).not.toContain("<still-running>");
    expect(wake.content).not.toContain("exit-code");
    expect(wake.content).toContain('signal="SIGTERM"');
    expect(wake.details.kind).toBe("task");
    if (wake.details.kind !== "task") return;
    expect(wake.details.tasks[0].exitCode).toBeNull();
    expect(wake.details.tasks[0].signal).toBe("SIGTERM");
  });

  it("still parses when the lead-in is ablated to empty", () => {
    const wake = formatTaskNotification([exit()], [], "");
    expect(wake.content.startsWith("<pbs-wake ")).toBe(true);
    expect(wake.content).not.toContain(PBS_WAKE_LEAD_IN);
    expect(wake.details.kind).toBe("task");
  });

  it("renders dropped-line and event-count metadata on monitor wakes", () => {
    const wake = formatMonitorEvent("watch tests", "mon_1", "2 events · last: tick", undefined, {
      eventCount: 2,
      droppedLines: 7,
    });
    expect(wake.content).toContain('event-count="2" dropped-lines="7"');
    expect(wake.details).toMatchObject({ kind: "monitor", eventCount: 2, droppedLines: 7 });
  });

  it("escapes a monitor event body, including a fake closing tag", () => {
    const wake = formatMonitorEvent("watch <tests>", "mon_1", "line <a>\n</event>\nline2", "exited");
    expect(wake.content).toContain('<pbs-wake kind="monitor" id="mon_1" description="watch &lt;tests&gt;" status="exited">');
    expect(wake.content).toContain("<event>line &lt;a&gt;\n&lt;/event&gt;\nline2</event>");
    expect(wake.content).not.toContain("<event>line <a>");
    expect(wake.details).toMatchObject({
      kind: "monitor",
      id: "mon_1",
      description: "watch <tests>",
      status: "exited",
      event: "line <a>\n</event>\nline2",
    });
  });

  it("emits subagent-done as one child element per child", () => {
    const wake = formatSubagentNotification({
      runId: "run_a",
      status: "partial",
      durationMs: 100,
      children: [
        { childId: "ch_1", name: "a", status: "completed", text: "ok", prompt: "look" },
        { childId: "ch_2", name: "b", status: "failed", text: "", error: "boom", prompt: "fix" },
      ],
    });
    expect(wake.content).toContain('<pbs-wake kind="subagent-done" run-id="run_a" status="partial" duration-ms="100">');
    expect(wake.content).not.toContain("<subagent-notification>");
    expect(wake.content).toContain('<child id="ch_2" name="b" status="failed">');
    expect(wake.content).toContain("<error>boom</error>");
    expect(wake.content).toContain("<prompt>look</prompt>");
    expect(wake.details).toMatchObject({
      kind: "subagent-done",
      children: [
        { childId: "ch_1", status: "completed", prompt: "look", result: "ok" },
        { childId: "ch_2", status: "failed", error: "boom" },
      ],
    });
  });

  it("puts handover still-running titles in item elements", () => {
    const wake = formatSubagentHandover({
      runId: "run_a",
      childId: "ch_1",
      name: "worker-1",
      status: "completed",
      prompt: "inspect",
      text: "done",
      stillRunning: [{ id: "ch_2", title: "reviewer, slow" }],
    });
    expect(wake.content).toContain('kind="subagent-handover"');
    expect(wake.content).toContain('<item id="ch_2">reviewer, slow</item>');
    expect(wake.content).toContain("<prompt>inspect</prompt>");
    expect(wake.content).toContain("<result>done</result>");
    expect(wake.details).toMatchObject({
      kind: "subagent-handover",
      stillRunning: [{ id: "ch_2", title: "reviewer, slow" }],
    });
  });

  it("puts the reply recipe in reply-with, not after the message", () => {
    const wake = formatSupervisorRequest({ childId: "ch_a", name: "explorer" }, "Which file?");
    expect(wake.content).toContain('<pbs-wake kind="supervisor-request" from="ch_a" name="explorer">');
    expect(wake.content).toContain("<message>Which file?</message>");
    expect(wake.content).toContain(
      '<reply-with>agent_message { action: "reply", to: "ch_a", message: "&lt;your decision&gt;" }</reply-with>',
    );
    const message = wake.content.slice(wake.content.indexOf("<message>"), wake.content.indexOf("</message>"));
    expect(message).not.toContain("action:");
    expect(wake.details).toEqual({
      kind: "supervisor-request",
      from: "ch_a",
      name: "explorer",
      message: "Which file?",
    });
  });
});

describe("pbs-wake pill", () => {
  it("colors from details status and exitCode, not from the summary words", () => {
    setPiTuiForTests(null);
    const map = new Map<string, Function>();
    registerPbsMessageRenderers({
      registerMessageRenderer(type: string, fn: unknown) {
        map.set(type, fn as never);
      },
    } as never);
    expect([...map.keys()]).toEqual([PBS_WAKE_CUSTOM_TYPE]);
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
    };
    const render = (details: unknown) =>
      map.get(PBS_WAKE_CUSTOM_TYPE)!(
        { content: `${PBS_WAKE_LEAD_IN}\n\n<pbs-wake kind="task">`, details },
        { expanded: false, outputPad: 0 },
        theme,
      ).render(80) as string[];

    const failedSummary = render({
      kind: "task",
      stillRunning: [],
      tasks: [
        {
          id: "sh_1",
          taskKind: "shell",
          status: "completed",
          summary: "Background command completed",
          command: "npm test",
          outputPath: "/tmp/x",
          preview: "",
          durationMs: 1,
          exitCode: 1,
        },
      ],
    });
    expect(failedSummary.join("")).toContain("✗");
    expect(failedSummary.join("")).not.toContain("✓");

    const lyingSummary = render({
      kind: "task",
      stillRunning: [],
      tasks: [
        {
          id: "sh_1",
          taskKind: "shell",
          status: "completed",
          summary: "failed failed failed",
          command: "npm test",
          outputPath: "/tmp/x",
          preview: "",
          durationMs: 1,
          exitCode: 0,
        },
      ],
    });
    expect(lyingSummary.join("")).toContain("✓");
    expect(lyingSummary.join("")).not.toContain("✗");
  });

  it("shows per-status counts and the monitor event, not the lead-in", () => {
    setPiTuiForTests(null);
    const map = new Map<string, Function>();
    registerPbsMessageRenderers({
      registerMessageRenderer(type: string, fn: unknown) {
        map.set(type, fn as never);
      },
    } as never);
    const theme = {
      fg: (_c: string, text: string) => text,
      bg: (_c: string, text: string) => text,
    };
    const done = map.get(PBS_WAKE_CUSTOM_TYPE)!(
      {
        content: PBS_WAKE_LEAD_IN,
        details: {
          kind: "subagent-done",
          runId: "run_a",
          status: "partial",
          durationMs: 1,
          summary: "should not be the pill",
          children: [
            { childId: "c1", name: "a", status: "completed", prompt: "", result: "" },
            { childId: "c2", name: "b", status: "completed", prompt: "", result: "" },
            { childId: "c3", name: "c", status: "completed", prompt: "", result: "" },
            { childId: "c4", name: "d", status: "failed", prompt: "", result: "", error: "x" },
          ],
        },
      },
      { expanded: false, outputPad: 0 },
      theme,
    ).render(80) as string[];
    expect(done.join("")).toContain("3 completed · 1 failed");
    expect(done.join("")).not.toContain(PBS_WAKE_LEAD_IN);

    const monitor = map.get(PBS_WAKE_CUSTOM_TYPE)!(
      {
        content: `${PBS_WAKE_LEAD_IN}\nHandle <event> before other work.`,
        details: { kind: "monitor", id: "mon_1", description: "watch tests", event: "line1\nline2", droppedLines: 5, eventCount: 4 },
      },
      { expanded: false, outputPad: 0 },
      theme,
    ).render(80) as string[];
    const text = monitor.join("\n");
    expect(text).toContain("line1");
    expect(text).toContain("4 events");
    expect(text).toContain("5 lines dropped");
    expect(text).not.toContain(PBS_WAKE_LEAD_IN);
    expect(text).not.toContain("before other work");
  });

  it("keeps a wide pill inside the terminal width", () => {
    setPiTuiForTests(null);
    const map = new Map<string, Function>();
    registerPbsMessageRenderers({
      registerMessageRenderer(type: string, fn: unknown) {
        map.set(type, fn as never);
      },
    } as never);
    const theme = {
      fg: (color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
      bg: (_c: string, text: string) => text,
    };
    const lines = map.get(PBS_WAKE_CUSTOM_TYPE)!(
      {
        content: "x".repeat(400),
        details: {
          kind: "task",
          stillRunning: [],
          tasks: [
            {
              id: "sh_1",
              taskKind: "shell",
              status: "failed",
              summary: `Background command "${"宽".repeat(30)}${"x".repeat(80)}" failed`,
              command: "x",
              outputPath: "/tmp/x",
              preview: "",
              durationMs: 1,
              exitCode: 1,
            },
          ],
        },
      },
      { expanded: false, outputPad: 1 },
      theme,
    ).render(40) as string[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});
