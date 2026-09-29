/**
 * Graders on hand-built transcripts, shaped after real batch-4 episodes
 * (2026-09-30) that the graders got wrong. Fast: no pi, no manager.
 *
 *   node --test ablation/scenarios.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Item } from "../lib/transcript.ts";
import type { Wake } from "../lib/wake-adapter.ts";
import { getScenario } from "./scenarios.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function episode(files: Record<string, string> = {}, secrets: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pbse-grade-"));
  dirs.push(root);
  const cwd = join(root, "w");
  const secretDir = join(root, "secret");
  mkdirSync(cwd);
  mkdirSync(secretDir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  for (const [name, text] of Object.entries(secrets)) writeFileSync(join(secretDir, name), `${text}\n`);
  return { cwd, secretDir };
}

let seq = 0;
const at = (s: number) => ({ seq: seq++, t: s * 1000 });
const call = (s: number, id: string, name: string, args: Record<string, unknown>): Item => ({
  kind: "assistant",
  ...at(s),
  text: "",
  toolCalls: [{ id, name, args }],
});
const say = (s: number, text: string): Item => ({ kind: "assistant", ...at(s), text, toolCalls: [] });
const backgrounded = (s: number, callId: string, taskId: string): Item => ({
  kind: "toolResult",
  ...at(s),
  toolCallId: callId,
  toolName: "bash",
  text: `moved to background (task_id: ${taskId})`,
  details: { backgrounded: true, task_id: taskId },
  isError: false,
});
const taskWake = (s: number, taskId: string, status: string, body = ""): Item => ({
  kind: "wake",
  ...at(s),
  wake: { kind: "task", taskIds: [taskId], status, body, stillRunning: [], tasks: [], children: [] } as unknown as Wake,
});

describe("bg-end-turn with no wake", () => {
  const grade = getScenario("bg-end-turn").grade;

  // k3-256k, batch 2: its first model call took 71s, it backgrounded build.sh
  // at 73s and the 75s episode cap came before the 15s build could finish.
  it("is INVALID when the episode ended before the build could finish", () => {
    seq = 0;
    const items = [call(71, "c1", "bash", { command: "./build.sh" }), backgrounded(73, "c1", "sh_1"), say(75, "running")];
    const r = grade({ items, ...episode() });
    assert.equal(r.pass, null, r.reason);
  });

  it("is a FAIL when the build had time to finish and no wake came", () => {
    seq = 0;
    const items = [call(3, "c1", "bash", { command: "./build.sh" }), backgrounded(5, "c1", "sh_1"), say(6, "waiting"), say(75, "still waiting")];
    const r = grade({ items, ...episode() });
    assert.equal(r.pass, false);
    assert.match(r.reason, /no task wake/);
  });
});

describe("still-running-continue", () => {
  const scenario = getScenario("still-running-continue");

  // gpt-5.6-luna #6: both scripts in one command with shell redirects.
  it("one command running both scripts is INVALID, not a lost wake", () => {
    seq = 0;
    const items = [
      call(8, "c1", "bash", { command: './quick.sh > quick.txt & q=$!; ./slow.sh > slow.txt & s=$!; wait "$q"; wait "$s"' }),
      backgrounded(10, "c1", "sh_1"),
      say(12, "running both"),
    ];
    const r = scenario.grade({ items, ...episode() });
    assert.equal(r.pass, null, r.reason);
  });

  // grok-4.6 #0: slow.sh got a 5s timeout, was killed, and was restarted;
  // quick.txt was written at 12s, the restarted slow.sh finished at 52s.
  it("judges 'before slow' against the slow.sh run that completed", () => {
    seq = 0;
    const items = [
      call(5, "q", "bash", { command: "./quick.sh" }),
      call(5, "s1", "bash", { command: "./slow.sh", timeout: 5 }),
      backgrounded(6, "q", "sh_q"),
      backgrounded(6, "s1", "sh_s1"),
      taskWake(10, "sh_s1", "killed"),
      call(11, "s2", "bash", { command: "./slow.sh" }),
      backgrounded(11, "s2", "sh_s2"),
      taskWake(11, "sh_q", "completed", "QUICK Q1"),
      call(12, "w", "write", { path: "quick.txt", content: "QUICK Q1\n" }),
      taskWake(52, "sh_s2", "completed", "SLOW S1"),
      call(53, "w2", "write", { path: "slow.txt", content: "SLOW S1\n" }),
    ];
    const r = scenario.grade({ items, ...episode({ "quick.txt": "QUICK Q1\n" }, { q: "Q1", s: "S1" }) });
    assert.equal(r.pass, true, r.reason);
  });
});
