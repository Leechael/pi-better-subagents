/**
 * Contract tests for format.ts pure functions — design.md Appendix A + §4.2/§4.5.
 *
 * Contract under test (Appendix A, verbatim):
 *   export interface TruncationInfo { truncated: boolean; totalLines: number; totalBytes: number }
 *   export function truncateTail(
 *     text: string, maxLines?: number (默认2000), maxBytes?: number (默认51200)
 *   ): { text: string } & TruncationInfo;
 *
 *   export interface TaskExitInfo {
 *     taskId: string; kind: string; command: string;
 *     status: "completed" | "failed" | "killed" | "orphaned";
 *     exitCode: number | null; durationMs: number;
 *     outputPath: string; preview: string;  // preview 由调用方先截断到 4000
 *   }
 *   export function formatTaskNotification(events: TaskExitInfo[]): string;
 *   export function formatBackgroundNotice(taskId: string, command: string, outputPath: string): string;
 *   export function formatMonitorEvent(description: string, taskId: string, batchText: string): string;
 */
import { describe, it, expect } from "vitest";
import {
  truncateTail,
  formatTaskNotification,
  formatBackgroundNotice,
  formatMonitorEvent,
  type TaskExitInfo,
} from "../src/format";

describe("truncateTail (contract: Appendix A)", () => {
  it("returns input unchanged when under both limits", () => {
    const text = "line1\nline2\nline3";
    const r = truncateTail(text, 2000, 51200);
    expect(r.text).toBe(text);
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(3);
    expect(r.totalBytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("keeps the TAIL (not the head) when over the line limit", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
    const text = lines.join("\n");
    const r = truncateTail(text, 10, 51200);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBe(100);
    expect(r.totalBytes).toBe(Buffer.byteLength(text, "utf8"));
    const kept = r.text.split("\n").filter((l) => /^L\d+$/.test(l));
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(kept).toContain("L100"); // last line always survives
    expect(kept).not.toContain("L1"); // head lines dropped
    expect(kept).not.toContain("L5");
  });

  it("enforces maxBytes as a hard cap on the returned text", () => {
    const line = "abcdefghij".repeat(10); // 100 bytes per line
    const text = Array.from({ length: 20 }, () => line).join("\n"); // ~2019 bytes
    const r = truncateTail(text, 2000, 500);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(500);
    expect(r.totalBytes).toBe(Buffer.byteLength(text, "utf8"));
    // AMBIGUITY(design): whether a truncation marker line may be added (and
    // whether it counts against maxBytes) is unspecified — hard cap asserted.
  });

  it("applies whichever limit is tighter (line limit here)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `row${i}`).join("\n");
    const r = truncateTail(text, 5, 51200);
    expect(r.truncated).toBe(true);
    const kept = r.text.split("\n").filter((l) => /^row\d+$/.test(l));
    expect(kept.length).toBeLessThanOrEqual(5);
    expect(kept).toContain("row49");
  });

  it("uses defaults of 2000 lines / 51200 bytes when args are omitted", () => {
    const text = Array.from({ length: 2100 }, (_, i) => `row${i}`).join("\n");
    const r = truncateTail(text);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBe(2100);
    const kept = r.text.split("\n").filter((l) => /^row\d+$/.test(l));
    expect(kept.length).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("row2099"); // tail kept under defaults
  });

  it("counts bytes as UTF-8, not UTF-16 code units", () => {
    const text = "你好世界"; // 4 chars, 12 bytes
    const r = truncateTail(text, 2000, 51200);
    expect(r.totalBytes).toBe(12);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });

  it("byte-truncation still respects the tail and stays within budget for multibyte text", () => {
    const text = "你".repeat(100); // 300 bytes
    const r = truncateTail(text, 2000, 10);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(10);
    expect(r.text).not.toContain("�"); // no mid-character cut surfaced
  });

  it("handles empty input", () => {
    const r = truncateTail("", 10, 10);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(0);
    // AMBIGUITY(design): totalLines for "" (0 vs 1) is unspecified — not asserted.
  });
});

describe("formatTaskNotification (contract: Appendix A + §4.5 XML template)", () => {
  const base: TaskExitInfo = {
    taskId: "sh_a1b2c3d4",
    kind: "shell",
    command: "npm run build",
    status: "completed",
    exitCode: 0,
    durationMs: 12345,
    outputPath: "/home/u/.pi/agent/pbs/sessions/s/tasks/sh_a1b2c3d4.output",
    preview: "last lines of output",
  };

  it("emits <task-notification> XML with every required field (§4.5 template)", () => {
    const xml = formatTaskNotification([base]);
    expect(xml).toContain("system wake");
    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("</task-notification>");
    expect(xml).toContain("<task-id>sh_a1b2c3d4</task-id>");
    expect(xml).toContain("<kind>shell</kind>");
    expect(xml).toContain("<status>completed</status>");
    expect(xml).toContain("<summary>");
    expect(xml).toContain("npm run build"); // command interpolated in summary
    expect(xml).toMatch(/exit code 0/); // per §4.5 summary template
    expect(xml).toContain(
      "<output-file>/home/u/.pi/agent/pbs/sessions/s/tasks/sh_a1b2c3d4.output</output-file>",
    );
    expect(xml).toContain("<preview>");
    expect(xml).toContain("last lines of output");
    expect(xml).toContain("<duration-ms>12345</duration-ms>");
  });

  it("merges multiple events into one message covering every task (§4.5 合批)", () => {
    const failed: TaskExitInfo = {
      ...base,
      taskId: "sh_deadbeef",
      kind: "shell",
      command: "make test",
      status: "failed",
      exitCode: 2,
    };
    const xml = formatTaskNotification([base, failed]);
    expect(xml).toContain("<task-notification");
    expect(xml).toContain("sh_a1b2c3d4");
    expect(xml).toContain("sh_deadbeef");
    expect(xml).toContain("<status>completed</status>");
    expect(xml).toContain("<status>failed</status>");
    // AMBIGUITY(design): exact merged structure (repeated blocks vs one block
    // with a list) is unspecified — only coverage of all events is asserted.
  });

  it("supports killed/orphaned statuses and null exit codes", () => {
    const killed: TaskExitInfo = {
      ...base,
      taskId: "sh_killed01",
      status: "killed",
      exitCode: null,
    };
    const xml = formatTaskNotification([killed]);
    expect(xml).toContain("sh_killed01");
    expect(xml).toContain("<status>killed</status>");
    // AMBIGUITY(design): summary wording for exitCode:null is unspecified.
  });

  it("does not emit raw XML metacharacters from command/preview (derived: output is XML)", () => {
    const tricky: TaskExitInfo = {
      ...base,
      command: 'grep "<tag>" & "quotes"',
      preview: "a < b && c > d",
    };
    const xml = formatTaskNotification([tricky]);
    expect(xml).toContain("sh_a1b2c3d4");
    // DERIVED EXPECTATION (unspecified in design): since the format is XML,
    // metacharacters must be escaped — raw `<tag>` would corrupt the document.
    expect(xml).not.toContain("<tag>");
    expect(xml).not.toContain("a < b");
  });
});

describe("formatBackgroundNotice (contract: Appendix A + §4.2 template)", () => {
  it("carries task id, output path, and the no-polling guidance", () => {
    const msg = formatBackgroundNotice("sh_a1b2c3d4", "npm run build", "/tmp/x.output");
    // §4.2: "Command moved to background (task_id: sh_x). Output: <path>.
    //        You will be notified when it completes. Do not poll or sleep."
    expect(msg).toContain("sh_a1b2c3d4");
    expect(msg).toContain("/tmp/x.output");
    expect(msg).toMatch(/background/i);
    expect(msg).toMatch(/notified/i);
    expect(msg).toMatch(/do not poll/i);
    // AMBIGUITY(design): whether the command text itself is interpolated is
    // unspecified (the §4.2 template omits it despite the parameter existing).
  });
});

describe("formatMonitorEvent (contract: Appendix A + §4.4)", () => {
  it("wraps the batch in a <monitor-event> element carrying description and task id", () => {
    const msg = formatMonitorEvent("cargo test failures", "mon_abc123", "test foo failed\n");
    // §4.4: `<monitor-event description task_id>` + 批文本
    expect(msg).toContain("<monitor-event");
    expect(msg).toContain("</monitor-event>");
    expect(msg).toContain("cargo test failures");
    expect(msg).toContain("mon_abc123");
    expect(msg).toContain("test foo failed");
    // AMBIGUITY(design): attribute syntax (quoting/order) is unspecified.
  });

  it("keeps multi-line batch text intact inside the element", () => {
    const batch = "line one\nline two\nline three";
    const msg = formatMonitorEvent("desc", "mon_x", batch);
    expect(msg).toContain("line one");
    expect(msg).toContain("line two");
    expect(msg).toContain("line three");
  });
});
