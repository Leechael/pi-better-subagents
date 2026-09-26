/**
 * Programmatic grading primitives over the normalized transcript. All wake
 * knowledge comes from lib/wake-adapter.ts via transcript items.
 */
import { type Item, type ToolCall, toolResults, wakes } from "../lib/transcript.ts";
import type { Wake } from "../lib/wake-adapter.ts";

export interface Grade {
  /** true/false = scored episode; null = invalid (setup precondition not met, excluded from rates). */
  pass: boolean | null;
  reason: string;
  metrics: Record<string, number | string | boolean>;
}

export type CallAt = ToolCall & { seq: number; t: number };

export function callsBetween(items: Item[], fromSeq: number, toSeq = Number.POSITIVE_INFINITY): CallAt[] {
  return items.flatMap((i) =>
    i.kind === "assistant" && i.seq > fromSeq && i.seq < toSeq ? i.toolCalls.map((c) => ({ ...c, seq: i.seq, t: i.t })) : [],
  );
}

export const cmd = (c: ToolCall) => (typeof c.args.command === "string" ? c.args.command : "");

/**
 * Polling = asking about background work instead of waiting for its wake:
 * task_output/task_list, subagent status/get/list, and bash that sleeps,
 * waits, or reads task output files.
 */
export function isPoll(c: ToolCall): boolean {
  if (c.name === "task_output" || c.name === "task_list") return true;
  if (c.name === "subagent" && ["status", "get", "list"].includes(String(c.args.action))) return true;
  if (c.name === "agent_message" && c.args.action === "list") return true;
  if (c.name === "bash") {
    const s = cmd(c);
    return /\bsleep\b|\bwait\b|\.output\b|pbs-manager|\bps\b|pgrep|\/tasks\//.test(s);
  }
  return false;
}

/** Bash tool results rejected by the extension's bare-sleep guard. */
export function blockedSleeps(items: Item[]): number {
  return toolResults(items).filter((r) => r.toolName === "bash" && r.isError && /bare sleep\/idle-loop/.test(r.text)).length;
}

/** Tool results that failed on arguments: schema errors, unknown actions, details.ok === false. */
export function wrongActions(items: Item[]): Array<{ tool: string; text: string }> {
  return toolResults(items)
    .filter(
      (r) =>
        (r.isError && /validation|invalid|must be equal to one of|unknown action|Expected union|requires/i.test(r.text)) ||
        (r.details && (r.details as { ok?: unknown }).ok === false),
    )
    .map((r) => ({ tool: r.toolName, text: r.text.slice(0, 200) }));
}

export function firstWake(items: Item[], pred: (w: Wake) => boolean, afterSeq = -1) {
  return wakes(items).find((w) => w.seq > afterSeq && pred(w.wake));
}

/** Assistant text strictly between two seqs. */
export function assistantTextBetween(items: Item[], fromSeq: number, toSeq = Number.POSITIVE_INFINITY): string {
  return items
    .filter((i) => i.kind === "assistant" && i.seq > fromSeq && i.seq < toSeq)
    .map((i) => (i as { text: string }).text)
    .join("\n");
}

export function finalAssistantText(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "assistant" && it.text.trim()) return it.text;
  }
  return "";
}

/**
 * Ack-and-stop after a wake: the model's response to the wake (assistant
 * messages up to the next wake or the end) makes no tool call.
 */
export function ackAndStop(items: Item[], wakeSeq: number): boolean {
  const next = wakes(items).find((w) => w.seq > wakeSeq)?.seq ?? Number.POSITIVE_INFINITY;
  const reply = items.filter((i) => i.kind === "assistant" && i.seq > wakeSeq && i.seq < next);
  return reply.length > 0 && reply.every((i) => i.kind === "assistant" && i.toolCalls.length === 0);
}

/** First tool call (at/after seq) that writes `file` via write/edit/bash redirection. */
export function firstWriteOf(items: Item[], file: string, afterSeq = -1): CallAt | undefined {
  const base = file.replace(/^.*\//, "");
  return callsBetween(items, afterSeq).find((c) => {
    if (c.name === "write" || c.name === "edit") return String(c.args.path ?? "").endsWith(base);
    if (c.name === "bash") return new RegExp(`>>?\\s*['"]?(\\./)?${base.replace(/\./g, "\\.")}`).test(cmd(c)) || new RegExp(`tee\\s+(-a\\s+)?['"]?(\\./)?${base.replace(/\./g, "\\.")}`).test(cmd(c));
    return false;
  });
}
