import { describe, expect, it } from "vitest";
import { formatSubagentHandover, formatSubagentNotification } from "../../src/format";

describe("formatSubagentNotification", () => {
  it("produces one subagent-done child per result", () => {
    const text = formatSubagentNotification({
      runId: "run_a1b2c3d4",
      status: "completed",
      durationMs: 41234,
      children: [
        { childId: "ch_1", name: "worker-1", status: "completed", text: "result one" },
        { childId: "ch_2", name: "worker-2", status: "completed", text: "result two" },
      ],
    }).content;
    expect(text).toContain('kind="subagent-done"');
    expect(text).not.toContain("<subagent-notification>");
    expect(text).toContain("System wake");
    expect(text).toContain('run-id="run_a1b2c3d4"');
    expect(text).toContain('status="completed"');
    expect(text).toContain("<summary>2/2 subagents completed in 41234ms</summary>");
    expect(text).toContain('<child id="ch_1" name="worker-1" status="completed">');
    expect(text).toContain('<child id="ch_2" name="worker-2" status="completed">');
    expect(text).toContain("<result>result one</result>");
  });

  it("summarizes partial runs and includes error lines", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "partial",
      durationMs: 100,
      children: [
        { childId: "ch_a", name: "a", status: "completed", text: "ok" },
        { childId: "ch_b", name: "b", status: "failed", text: "", error: "boom" },
      ],
    }).content;
    expect(text).toContain("1/2 subagents completed in 100ms");
    expect(text).toContain('<child id="ch_b" name="b" status="failed">');
    expect(text).toContain("<error>boom</error>");
  });

  it("XML-escapes child output", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ childId: "ch_a", name: "a<b>", status: "completed", text: "x < y & z > w" }],
    }).content;
    expect(text).toContain('name="a&lt;b&gt;"');
    expect(text).toContain("x &lt; y &amp; z &gt; w");
    expect(text).not.toContain("a<b>");
  });

  it("keeps only the 2000-char tail of each child result", () => {
    const long = "x".repeat(3000);
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ childId: "ch_a", name: "a", status: "completed", text: long }],
    }).content;
    expect(text).not.toContain(long);
    expect(text).toContain("x".repeat(2000));
  });

  it("includes each child's prompt in the run results", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ childId: "ch_a", name: "a", status: "completed", text: "done", prompt: "look at src" }],
    }).content;
    expect(text).toContain("<prompt>look at src</prompt>");
  });
});

describe("formatSubagentHandover", () => {
  it("gives the parent the prompt, the result, and who is still running", () => {
    const text = formatSubagentHandover({
      runId: "run_a",
      childId: "ch_1",
      name: "worker-1",
      status: "completed",
      prompt: "inspect the loader",
      text: "loader reads mtime",
      stillRunning: [{ id: "ch_2", title: "worker-2" }],
    }).content;
    expect(text).toContain('kind="subagent-handover"');
    expect(text).toContain("<prompt>inspect the loader</prompt>");
    expect(text).toContain("<result>loader reads mtime</result>");
    expect(text).toContain('<item id="ch_2">worker-2</item>');
    expect(text).toContain('child-id="ch_1"');
  });
});
