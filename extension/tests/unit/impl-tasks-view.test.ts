import { describe, expect, it } from "vitest";
import { formatConversation, turnsFromMessages } from "../../src/subagent/conversation";
import { stderrPathFor } from "../../src/tui/task-output-paths";
import { formatWorkRows, moveSelection, stopChoice } from "../../src/tui/tasks-command";
import { WorkIndex, type WorkItem } from "../../src/work-index";

function item(id: string, status: string): WorkItem {
  return {
    id,
    kind: "shell",
    status,
    title: id,
    startedAt: 1,
    countsAsWorker: true,
  };
}

describe("tasks view", () => {
  it("stops the selected id after a reorder, not whatever landed on that index", () => {
    const first = item("sh_1", "running");
    const second = item("sh_2", "running");
    let selected = moveSelection([first, second], first.id, 1);
    expect(selected).toBe("sh_2");
    // Item 1 finishes and drops below the active items. Index 0 is now sh_2.
    const reordered = [second, { ...first, status: "completed", endedAt: 2 }];
    expect(stopChoice(reordered, selected)).toEqual({ action: "stop", id: "sh_2" });
  });

  it("does not stop a finished selection", () => {
    const done = item("sh_2", "completed");
    expect(stopChoice([done], done.id)).toEqual({ action: "already-finished", id: "sh_2" });
  });

  it("lists a running monitor in the overlay rows", () => {
    const index = new WorkIndex({ now: () => 10_000 });
    index.upsert({
      id: "mon_abc",
      kind: "monitor",
      status: "running",
      title: "build watcher",
      startedAt: 0,
      countsAsWorker: false,
    });
    const rows = formatWorkRows(index.list(), "mon_abc", 10_000, 80);
    expect(rows.join("\n")).toContain("monitor");
    expect(rows.join("\n")).toContain("build watcher");
    expect(rows.join("\n")).toContain("running");
  });

  it("keeps a finished item viewable inside the retain window", () => {
    const index = new WorkIndex({ now: () => 1_000, retainMs: 10_000, finishedCap: 50 });
    index.upsert({
      id: "ch_done",
      kind: "agent",
      status: "completed",
      title: "scout",
      startedAt: 0,
      endedAt: 500,
      countsAsWorker: false,
    });
    expect(index.list().map((i) => i.id)).toEqual(["ch_done"]);
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
    expect(stderrPathFor("/tmp/tasks/sh_ab.output")).toBe("/tmp/tasks/sh_ab.stderr");
  });

});
