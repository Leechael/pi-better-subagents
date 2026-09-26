/**
 * Live child transcripts for the CLI (`pbs-manager agent ch_…`, `show ch_…`).
 *
 * Layout: <home>/sessions/<session_id>/agents/<child_id>.jsonl, one JSON object
 * per conversation turn: { ts, role, text, tool?, isError? }. Lines are only
 * ever appended; a turn already written is never rewritten.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../clock";
import { agentRecordsDir } from "./agent-records";
import type { ConversationTurn } from "./types";

/** Per-line text cap; keeps every line well under the 4 KiB event-line budget used elsewhere. */
const MAX_TEXT_CHARS = 3000;

export function transcriptPath(home: string, sessionId: string, childId: string): string {
  return `${agentRecordsDir(home, sessionId)}/${childId}.jsonl`;
}

function capText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}… (${text.length} chars)`;
}

/** `tool read` / `tool bash error` → tool name + error flag. */
function toolOf(role: string): { tool: string; isError: boolean } | undefined {
  const m = /^tool (\S+)( error)?$/.exec(role);
  return m ? { tool: m[1], isError: m[2] !== undefined } : undefined;
}

export function transcriptLine(turn: ConversationTurn, ts: number): string {
  const tool = toolOf(turn.role);
  const modelError = turn.role === "assistant error";
  const line = tool
    ? { ts, role: "tool", tool: tool.tool, text: capText(turn.text), ...(tool.isError ? { isError: true } : {}) }
    : { ts, role: modelError ? "assistant" : turn.role, text: capText(turn.text), ...(modelError ? { isError: true } : {}) };
  return `${JSON.stringify(line)}\n`;
}

export class TranscriptWriter {
  private readonly written = new Map<string, number>();
  private readonly toolCalls = new Map<string, number>();

  constructor(
    private readonly home: string,
    private readonly clock: Clock,
  ) {}

  /** Append turns not yet written. Returns the transcript path. */
  sync(sessionId: string, childId: string, turns: readonly ConversationTurn[]): string {
    const path = transcriptPath(this.home, sessionId, childId);
    const done = this.written.get(childId) ?? 0;
    if (turns.length <= done) return path;
    const fresh = turns.slice(done);
    const ts = this.clock.now();
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, fresh.map((t) => transcriptLine(t, ts)).join(""));
    } catch {
      return path; // best-effort: a later sync retries the same turns
    }
    this.written.set(childId, turns.length);
    const tools = fresh.filter((t) => toolOf(t.role) !== undefined).length;
    this.toolCalls.set(childId, (this.toolCalls.get(childId) ?? 0) + tools);
    return path;
  }

  toolCallCount(childId: string): number {
    return this.toolCalls.get(childId) ?? 0;
  }
}
