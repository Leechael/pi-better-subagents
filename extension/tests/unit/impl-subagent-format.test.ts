import { describe, expect, it } from "vitest";
import { formatSubagentHandover, formatSubagentNotification } from "../../src/format";

describe("formatSubagentNotification", () => {
  it("produces the §4.6 XML structure", () => {
    const text = formatSubagentNotification({
      runId: "run_a1b2c3d4",
      status: "completed",
      durationMs: 41234,
      children: [
        { name: "worker-1", status: "completed", text: "result one" },
        { name: "worker-2", status: "completed", text: "result two" },
      ],
    });
    expect(text).toContain("<subagent-notification>");
    expect(text).toContain("</subagent-notification>");
    expect(text).toContain("system wake");
    expect(text).toContain("continue your plan");
    expect(text).toContain("<run-id>run_a1b2c3d4</run-id>");
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("<summary>2/2 subagents completed in 41234ms</summary>");
    expect(text).toContain("## worker-1 (completed)");
    expect(text).toContain("## worker-2 (completed)");
    expect(text).toContain("result one");
  });

  it("summarizes partial runs and includes error lines", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "partial",
      durationMs: 100,
      children: [
        { name: "a", status: "completed", text: "ok" },
        { name: "b", status: "failed", text: "", error: "boom" },
      ],
    });
    expect(text).toContain("1/2 subagents completed in 100ms");
    expect(text).toContain("## b (failed)");
    expect(text).toContain("Error: boom");
  });

  it("XML-escapes child output", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ name: "a<b>", status: "completed", text: "x < y & z > w" }],
    });
    expect(text).toContain("a&lt;b&gt;");
    expect(text).toContain("x &lt; y &amp; z &gt; w");
    expect(text).not.toContain("a<b>");
  });

  it("keeps only the 2000-char tail of each child result", () => {
    const long = "x".repeat(3000);
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ name: "a", status: "completed", text: long }],
    });
    // The full 3000-char body must not appear; its 2000-char tail does.
    expect(text).not.toContain(long);
    expect(text).toContain("x".repeat(2000));
  });

  it("includes each child's prompt in the run results", () => {
    const text = formatSubagentNotification({
      runId: "run_x",
      status: "completed",
      durationMs: 1,
      children: [{ name: "a", status: "completed", text: "done", prompt: "look at src" }],
    });
    expect(text).toContain("Prompt: look at src");
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
      stillRunning: ["worker-2 (ch_2)"],
    });
    expect(text).toContain("<subagent-handover>");
    expect(text).toContain("Do not wait for the rest of the run");
    expect(text).toContain("<prompt>");
    expect(text).toContain("inspect the loader");
    expect(text).toContain("loader reads mtime");
    expect(text).toContain("worker-2 (ch_2)");
    expect(text).toContain("<child-id>ch_1</child-id>");
  });
});
