import { describe, expect, it } from "vitest";
import { formatPbsWake, PBS_WAKE_CUSTOM_TYPE, PBS_WAKE_LEAD_IN } from "../../src/wake";

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
