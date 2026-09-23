import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { agentEndReason, writeAgentChildRecord } from "../../src/subagent/agent-records";
import { TranscriptWriter, transcriptPath } from "../../src/subagent/transcript";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pbs-transcript-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("child transcript", () => {
  it("appends only new turns and counts tool results", () => {
    const home = tempHome();
    const clock = new ManualClock(1_000);
    const writer = new TranscriptWriter(home, clock);
    const turns = [
      { role: "user", text: "inspect the repo" },
      { role: "assistant", text: "tool read {\"path\":\"README.md\"}" },
      { role: "tool read", text: "# readme" },
    ];
    const path = writer.sync("sid", "ch_1", turns);
    clock.advanceBy(500);
    writer.sync("sid", "ch_1", [...turns, { role: "tool bash error", text: "exit 2" }, { role: "assistant", text: "done" }]);
    writer.sync("sid", "ch_1", [...turns]); // shorter snapshot: nothing rewritten

    expect(path).toBe(transcriptPath(home, "sid", "ch_1"));
    const got = lines(path);
    expect(got.map((l) => l.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(got[2]).toMatchObject({ tool: "read", text: "# readme", ts: 1_000 });
    expect(got[3]).toMatchObject({ tool: "bash", isError: true, ts: 1_500 });
    expect(writer.toolCallCount("ch_1")).toBe(2);
  });

  it("caps long turn text so each line stays small", () => {
    const home = tempHome();
    const writer = new TranscriptWriter(home, new ManualClock(0));
    const path = writer.sync("sid", "ch_2", [{ role: "assistant", text: "x".repeat(20_000) }]);
    expect(Buffer.byteLength(readFileSync(path, "utf8"))).toBeLessThan(4096);
  });

  it("maps terminal outcomes to end reasons", () => {
    expect(agentEndReason("completed", undefined)).toBe("completed");
    expect(agentEndReason("failed", { error: "529 overloaded", endReason: "model-error" })).toBe("model-error");
    expect(agentEndReason("failed", { error: "stalled" })).toBe("stalled");
    expect(agentEndReason("failed", { error: "boom" })).toBe("failed");
    expect(agentEndReason("interrupted", { error: "timeout" })).toBe("timeout");
    expect(agentEndReason("interrupted", { error: "disposed" })).toBe("disposed");
    expect(agentEndReason("interrupted", { error: "cancelled (fail_fast)" })).toBe("interrupted");
    expect(agentEndReason("running", undefined)).toBeUndefined();
  });
});

// Contract check against the real CLI: what the extension writes is what
// `pbs-manager show` / `agent` read. Skipped when the manager is not built.
const managerBin = join(__dirname, "../../../manager/target/debug/pbs-manager");
describe.skipIf(!existsSync(managerBin))("CLI reads extension-written agent files", () => {
  it("show and agent render the record and transcript", () => {
    const home = tempHome();
    const writer = new TranscriptWriter(home, new ManualClock(1_726_000_000_000));
    const transcript = writer.sync("sess-a", "ch_cafe0001", [
      { role: "user", text: "count the files" },
      { role: "tool bash", text: "42" },
      { role: "assistant", text: "There are 42 files." },
    ]);
    writeAgentChildRecord(home, {
      v: 1,
      kind: "agent",
      child_id: "ch_cafe0001",
      run_id: "run_0001",
      session_id: "sess-a",
      name: "counter",
      agent: "worker",
      status: "failed",
      started_at: 1_726_000_000_000,
      ended_at: 1_726_000_005_000,
      error: "529 overloaded_error",
      end_reason: "model-error",
      prompt_head: "count the files",
      result_tail: "There are 42 files.",
      tool_calls: writer.toolCallCount("ch_cafe0001"),
      transcript,
    });
    const run = (args: string[]) =>
      execFileSync(managerBin, ["--home", home, ...args], { encoding: "utf8", env: { ...process.env, PBS_HOME: home } });

    const show = run(["show", "ch_cafe0001"]);
    expect(show).toContain("model-error");
    expect(show).toContain("529 overloaded_error");
    expect(show).toContain("There are 42 files.");

    const agent = run(["agent", "ch_cafe0001"]);
    expect(agent).toContain("tool bash");
    expect(agent).toContain("There are 42 files.");
  });
});

describe("model errors in the conversation", () => {
  it("keeps a failed model call visible even when it produced no text", async () => {
    const { turnsFromMessages } = await import("../../src/subagent/conversation");
    const turns = turnsFromMessages([
      { role: "user", content: "do something" },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded_error" },
    ]);
    expect(turns.at(-1)).toEqual({ role: "assistant error", text: "529 overloaded_error" });
    const home = tempHome();
    const path = new TranscriptWriter(home, new ManualClock(0)).sync("s", "ch_e", turns);
    expect(lines(path).at(-1)).toMatchObject({ role: "assistant", isError: true, text: "529 overloaded_error" });
  });
});
