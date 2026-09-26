/**
 * Parent bash only wakes the session for backgrounded commands.
 * Child-bash sync waits must not call markNotifyOnExit (covered by its deps shape).
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashOverride, type BashOverrideDeps } from "../../src/bash-override";
import { DEFAULT_CONFIG } from "../../src/config";
import type { ManagerClient } from "../../src/manager-client";

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): ManagerClient {
  return {
    ensureAvailable: vi.fn(async () => true),
    start: vi.fn(async () => ({ task_id: "sh_parent01", pid: 111 })),
    wait: vi.fn(async () => ({ done: true, exit_code: 0 })),
    output: vi.fn(async () => ({
      chunk: "ok\n",
      next_cursor: 3,
      status: "completed",
      exit_code: 0,
      total_size: 3,
    })),
    stop: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ManagerClient;
}

function makeDeps(client: ManagerClient): BashOverrideDeps {
  return {
    getClient: () => client,
    config: { ...DEFAULT_CONFIG, foregroundBudgetMs: 50 },
    home: "/tmp/pbs-test",
    sessionId: () => "sess",
    sessionEnv: () => ({}),
    trackTask: vi.fn(),
    markNotifyOnExit: vi.fn(),
  };
}

const ctx = {
  cwd: "/tmp",
  sessionManager: { getSessionId: () => "sess", getSessionFile: () => null },
} as unknown as ExtensionContext;

describe("parent bash markNotifyOnExit", () => {
  it("does not mark notify when the command finishes within the foreground budget", async () => {
    const client = fakeClient();
    const deps = makeDeps(client);
    const tool = createBashOverride(deps);
    await tool.execute("tc", { command: "echo ok" }, undefined, undefined, ctx);
    expect(deps.markNotifyOnExit).not.toHaveBeenCalled();
  });

  it("marks notify when run_in_background is set", async () => {
    const client = fakeClient();
    const deps = makeDeps(client);
    const tool = createBashOverride(deps);
    await tool.execute(
      "tc",
      { command: "make long-build", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    expect(deps.markNotifyOnExit).toHaveBeenCalledWith("sh_parent01");
  });

  it("marks notify when the foreground budget expires (auto-background)", async () => {
    const client = fakeClient({
      wait: vi.fn(async () => ({ done: false })),
    });
    const deps = makeDeps(client);
    const tool = createBashOverride(deps);
    await tool.execute("tc", { command: "make long-build" }, undefined, undefined, ctx);
    expect(deps.markNotifyOnExit).toHaveBeenCalledWith("sh_parent01");
  });
});
