import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerClient } from "../../src/manager-client";
import { createChildBashTool, type ChildBashDeps } from "../../src/subagent/child-bash";

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): ManagerClient {
  return {
    ensureAvailable: vi.fn(async () => true),
    start: vi.fn(async () => ({ task_id: "sh_test1234", pid: 4321 })),
    wait: vi.fn(async () => ({ done: true, exit_code: 0 })),
    output: vi.fn(async () => ({
      chunk: "hello\n",
      next_cursor: 6,
      status: "completed",
      exit_code: 0,
      total_size: 6,
    })),
    stop: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ManagerClient;
}

function makeDeps(client: ManagerClient | null): ChildBashDeps & { client: ManagerClient | null } {
  return {
    client,
    getClient: () => client,
    home: "/tmp/pbs-test",
    sessionId: () => "parent-session",
    sessionEnv: () => ({ PI_SESSION_ID: "parent-session" }),
    trackTask: vi.fn(),
  };
}

const ctx = { cwd: "/tmp" } as ExtensionContext;

describe("child bash (no-background variant)", () => {
  it("rejects bare sleep commands", async () => {
    const deps = makeDeps(fakeClient());
    const tool = createChildBashTool(deps);
    await expect(
      tool.execute("tc", { command: "sleep 30" }, undefined, undefined, ctx),
    ).rejects.toThrow(/Refusing to run a bare sleep/);
    // The schema has no run_in_background at all.
    expect(JSON.stringify(tool.parameters)).not.toContain("run_in_background");
  });

  it("runs to completion via manager start + wait and returns output", async () => {
    const client = fakeClient();
    const deps = makeDeps(client);
    const tool = createChildBashTool(deps);
    const result = await tool.execute("tc", { command: "echo hello" }, undefined, undefined, ctx);
    expect(client.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "shell",
        command: "echo hello",
        run_in_background: false,
        timeout_ms: null,
      }),
    );
    expect(deps.trackTask).toHaveBeenCalledWith("sh_test1234", {
      kind: "shell",
      command: "echo hello",
    });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toBe("hello\n");
    expect((result.details as { task_id?: string }).task_id).toBe("sh_test1234");
  });

  it("throws on non-zero exit with the output attached", async () => {
    const client = fakeClient({
      wait: vi.fn(async () => ({ done: true, exit_code: 3 })),
      output: vi.fn(async () => ({
        chunk: "some error\n",
        next_cursor: 11,
        status: "failed",
        exit_code: 3,
        total_size: 11,
      })),
    });
    const tool = createChildBashTool(makeDeps(client));
    await expect(
      tool.execute("tc", { command: "false-ish" }, undefined, undefined, ctx),
    ).rejects.toThrow(/Command exited with code 3/);
  });

  it("fails clearly when the manager is unavailable", async () => {
    const tool = createChildBashTool(makeDeps(null));
    await expect(
      tool.execute("tc", { command: "echo hi" }, undefined, undefined, ctx),
    ).rejects.toThrow(/pbs-manager is not available/);
  });

  it("stops the task and reports an abort when the signal fires", async () => {
    const client = fakeClient({
      wait: vi.fn(() => new Promise(() => {})), // never resolves
    });
    const tool = createChildBashTool(makeDeps(client));
    const controller = new AbortController();
    const pending = tool.execute("tc", { command: "long" }, controller.signal, undefined, ctx);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(client.stop).toHaveBeenCalledWith("sh_test1234");
  });

  describe("timeout (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("kills the task and returns a timeout error instead of backgrounding", async () => {
      const client = fakeClient({
        // Each wait consumes its budget in fake time and reports not-done.
        wait: vi.fn(async (_id: string, budgetMs: number) => {
          vi.advanceTimersByTime(budgetMs);
          return { done: false };
        }),
      });
      const tool = createChildBashTool(makeDeps(client));
      const pending = tool.execute(
        "tc",
        { command: "slow", timeout: 5 },
        undefined,
        undefined,
        ctx,
      );
      const assertion = expect(pending).rejects.toThrow(/timed out after 5 seconds and was killed/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(client.stop).toHaveBeenCalledWith("sh_test1234");
    });
  });
});
