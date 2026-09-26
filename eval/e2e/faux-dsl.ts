/**
 * Tiny DSL for faux-model scripts. Script modules run INSIDE the pi process
 * (loaded by harness/faux-ext.ts through pi's extension loader), so they may
 * only import pi-ai (aliased by pi) and node built-ins.
 */
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";

type AssistantMessage = ReturnType<typeof fauxAssistantMessage>;

/** Provider-level message as the faux model receives it. */
export interface CtxMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  details?: unknown;
  [key: string]: unknown;
}

export interface FauxCallContext {
  messages: CtxMessage[];
  /** Zero-based LLM call number. */
  call: number;
}

export type FauxStep =
  | AssistantMessage
  | ((ctx: FauxCallContext) => AssistantMessage | Promise<AssistantMessage>);

export interface FauxScript {
  steps: FauxStep[];
  /** Answers every call after the script is exhausted (e.g. repeated wakes). */
  fallback?: FauxStep;
}

export function say(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

export function call(name: string, args: JsonObject, text?: string): AssistantMessage {
  const content = text ? [{ type: "text" as const, text }, fauxToolCall(name, args)] : [fauxToolCall(name, args)];
  return fauxAssistantMessage(content, { stopReason: "toolUse" });
}

/** Several tool calls in one assistant message (executed in parallel by pi). */
export function calls(list: Array<[string, JsonObject]>): AssistantMessage {
  return fauxAssistantMessage(
    list.map(([name, args]) => fauxToolCall(name, args)),
    { stopReason: "toolUse" },
  );
}

export function textOf(message: CtxMessage | undefined): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b: { type?: string; text?: string }) => (b && b.type === "text" ? (b.text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** Most recent tool result message, optionally for one tool. */
export function lastToolResult(ctx: FauxCallContext, toolName?: string): CtxMessage | undefined {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role === "toolResult" && (toolName === undefined || m.toolName === toolName)) return m;
  }
  return undefined;
}

/** Text of the last non-assistant message (what woke / prompted this call). */
export function lastInputText(ctx: FauxCallContext): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== "assistant" && m.role !== "system") return textOf(m);
  }
  return "";
}
