import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "./clock";

export type ExtensionEventFields = Record<string, unknown>;

/** Append extension observability events to the session's shared events.jsonl. */
export class ExtensionEventLog {
  constructor(
    private readonly home: string,
    private readonly sessionId: () => string,
    private readonly now: () => number,
  ) {}

  write(type: string, fields: ExtensionEventFields = {}): void {
    const sid = this.sessionId();
    if (!sid) return;
    try {
      const file = join(this.home, "sessions", sid, "events.jsonl");
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${formatExtensionEventLine({ ...fields, ts: this.now(), src: "extension", type })}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    } catch {
      // Observability must never break extension behavior.
    }
  }
}

export function formatExtensionEventLine(event: ExtensionEventFields): string {
  const bounded: ExtensionEventFields = { ...event };
  let truncated = false;
  for (const [key, value] of Object.entries(bounded)) {
    if (typeof value === "string" && value.length > 700) {
      bounded[key] = `${value.slice(0, 699)}…`;
      truncated = true;
    } else if (Array.isArray(value) && value.length > 32) {
      bounded[key] = value.slice(0, 32);
      truncated = true;
    }
  }
  if (truncated) bounded.truncated = true;
  let line = JSON.stringify(bounded);
  while (Buffer.byteLength(line, "utf8") + 1 >= 4096) {
    const candidate = Object.entries(bounded).find(([, value]) => typeof value === "string" && value.length > 64);
    if (!candidate) {
      line = JSON.stringify({ ts: event.ts, src: "extension", type: event.type, truncated: true });
      break;
    }
    const [key, value] = candidate;
    bounded[key] = `${(value as string).slice(0, Math.max(0, Math.floor((value as string).length / 2) - 1))}…`;
    bounded.truncated = true;
    line = JSON.stringify(bounded);
  }
  return line;
}

export function createExtensionEventLog(home: string, sessionId: () => string, clock: Clock): ExtensionEventLog {
  return new ExtensionEventLog(home, sessionId, () => clock.now());
}
