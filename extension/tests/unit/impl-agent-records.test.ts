import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAgentCommand,
  isAgentStatusActive,
  loadAgentChildRecords,
  writeAgentChildRecord,
  type AgentChildRecord,
} from "../../src/subagent/agent-records";

describe("agent child records", () => {
  let home: string;
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a running agent record for ls / task_list", () => {
    home = mkdtempSync(join(tmpdir(), "pbs-agent-rec-"));
    const rec: AgentChildRecord = {
      v: 1,
      kind: "agent",
      child_id: "ch_deadbeef",
      run_id: "run_cafebabe",
      session_id: "sess-1",
      name: "fix-pr2153",
      agent: "worker",
      model: "openai-codex/gpt-5.6-sol",
      status: "running",
      started_at: 1000,
    };
    writeAgentChildRecord(home, rec);
    const loaded = loadAgentChildRecords(home);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      child_id: "ch_deadbeef",
      name: "fix-pr2153",
      status: "running",
      model: "openai-codex/gpt-5.6-sol",
    });
    expect(isAgentStatusActive(loaded[0].status)).toBe(true);
    expect(formatAgentCommand(loaded[0])).toBe(
      "agent:fix-pr2153 (worker) openai-codex/gpt-5.6-sol",
    );
  });

  it("hides terminal records unless includeTerminal is set", () => {
    home = mkdtempSync(join(tmpdir(), "pbs-agent-rec-"));
    writeAgentChildRecord(home, {
      v: 1,
      kind: "agent",
      child_id: "ch_done0001",
      run_id: "run_done0001",
      session_id: "sess-1",
      name: "done",
      agent: "worker",
      status: "completed",
      started_at: 1,
      ended_at: 2,
    });
    expect(loadAgentChildRecords(home)).toHaveLength(0);
    expect(loadAgentChildRecords(home, { includeTerminal: true })).toHaveLength(1);
  });

  it("treats a running record as not running when its session is disconnected", () => {
    home = mkdtempSync(join(tmpdir(), "pbs-agent-rec-"));
    writeAgentChildRecord(home, {
      v: 1,
      kind: "agent",
      child_id: "ch_ghost001",
      run_id: "run_ghost001",
      session_id: "gone-session",
      name: "ghost",
      agent: "worker",
      status: "running",
      started_at: 1,
    });
    const loaded = loadAgentChildRecords(home, {
      connectedSessionIds: new Set(["live-session"]),
    });
    expect(loaded.map((r) => r.child_id)).not.toContain("ch_ghost001");
  });
});
