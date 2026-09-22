import { afterEach, describe, expect, it } from "vitest";
import { formatConversation, turnsFromMessages } from "../../src/subagent/conversation";
import { stderrPathFor } from "../../src/tui/task-output-paths";
import { clearPinnedSubagents, pinSubagent, unpinSubagent } from "../../src/tui/tasks-pin";
import { visibleSubagentChildren } from "../../src/tui/tasks-command";
import type { RunRecord } from "../../src/subagent/registry";

function child(id: string, status: RunRecord["children"][number]["status"]): RunRecord["children"][number] {
  return {
    childId: id,
    name: id,
    agent: "worker",
    status,
    startedAt: 1,
  };
}

function run(children: RunRecord["children"]): RunRecord {
  return {
    runId: "run_1",
    kind: "tasks",
    children,
    status: "running",
    createdAt: 1,
  };
}

describe("tasks view helpers", () => {
  afterEach(() => {
    clearPinnedSubagents();
  });

  it("lists running subagents and hides finished ones", () => {
    const visible = visibleSubagentChildren([
      run([child("ch_live", "running"), child("ch_done", "completed")]),
    ]);
    expect(visible.map((c) => c.childId)).toEqual(["ch_live"]);
  });

  it("keeps a finished subagent only while its detail view is open", () => {
    const runs = [run([child("ch_done", "completed")])];
    pinSubagent("ch_done");
    expect(visibleSubagentChildren(runs).map((c) => c.childId)).toEqual(["ch_done"]);
    unpinSubagent("ch_done");
    expect(visibleSubagentChildren(runs)).toEqual([]);
  });

  it("formats a child transcript and the stderr sibling path", () => {
    const text = formatConversation(
      turnsFromMessages([
        { role: "user", content: "look at src" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "toolCall", name: "read", arguments: { path: "src" } },
          ],
        },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false },
      ]),
    );
    expect(text).toContain("── user ──");
    expect(text).toContain("look at src");
    expect(text).toContain("tool read");
    expect(text).toContain("── tool read ──");
    expect(text).toContain("file body");
    expect(stderrPathFor("/tmp/tasks/sh_ab.output")).toBe("/tmp/tasks/sh_ab.stderr");
  });
});
