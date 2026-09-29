import { describe, expect, it } from "vitest";
import type { ManagerClient, OutputResponse } from "../../src/manager-client";
import { ManualClock } from "../../src/clock";
import { createTaskOutputTool } from "../../src/task-tools";
import { WorkIndex } from "../../src/work-index";

// Manual testing (2026-09-29): with a prek hook and `gh pr checks --watch`
// backgrounded, the agent called task_output dozens of times in one run, each
// returning "(no output yet)" while the task kept running. The prompt said
// "do not poll" in three places; the tool itself never pushed back.
describe("task_output poll guard", () => {
  function setup() {
    const state: OutputResponse = { chunk: "", next_cursor: 0, status: "running", exit_code: null, total_size: 0 };
    const client = {
      ensureAvailable: async () => true,
      isAvailable: () => true,
      output: async (_id: string, cursor: number, _max: number) => ({
        ...state,
        chunk: state.chunk.slice(cursor),
        next_cursor: state.total_size,
      }),
    } as unknown as ManagerClient;
    const tool = createTaskOutputTool({ getClient: () => client });
    const read = async (id = "sh_1") => {
      const res = await tool.execute("t", { task_id: id }, undefined as never, undefined as never, {} as never);
      return (res.content[0] as { text: string }).text;
    };
    const write = (text: string) => {
      state.chunk += text;
      state.total_size = state.chunk.length;
    };
    return { state, read, write };
  }

  it("tells the model to end its turn when a running task has nothing yet", async () => {
    const { read } = setup();
    const text = await read();
    expect(text).toMatch(/end your turn/i);
    expect(text).toMatch(/pbs-wake/);
  });

  it("refuses a repeat read of a running task with no new output", async () => {
    const { read } = setup();
    await read();
    await expect(read()).rejects.toThrow(/end your turn/i);
  });

  it("allows another read once the task has written more", async () => {
    const { read, write } = setup();
    write("line 1\n");
    await read();
    write("line 2\n");
    expect(await read()).toContain("line 2");
    await expect(read()).rejects.toThrow(/no new output/i);
  });

  it("tracks tasks separately", async () => {
    const { read } = setup();
    await read("sh_1");
    await expect(read("sh_2")).resolves.toMatch(/end your turn/i);
  });

  it("never blocks reads of a finished task", async () => {
    const { state, read, write } = setup();
    write("done\n");
    await read();
    state.status = "completed";
    state.exit_code = 0;
    expect(await read()).toContain("done");
    expect(await read()).toContain("done");
  });

  it("refuses a repeat read of a running subagent with nothing new", async () => {
    const index = new WorkIndex({ clock: new ManualClock(0) });
    index.upsert({ id: "ch_1", kind: "agent", status: "running", title: "c", startedAt: 0, countsAsWorker: false });
    const tool = createTaskOutputTool({ getClient: () => null, getIndex: () => index });
    const read = () => tool.execute("t", { task_id: "ch_1" }, undefined as never, undefined as never, {} as never);
    const first = await read();
    expect((first.content[0] as { text: string }).text).toMatch(/end your turn/i);
    await expect(read()).rejects.toThrow(/no new output/i);
  });

  it("says in its description that it is not a way to wait", () => {
    const tool = createTaskOutputTool({ getClient: () => null });
    expect(tool.description).toMatch(/not.*wait/i);
  });
});
