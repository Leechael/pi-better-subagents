/**
 * Flatten a child AgentSession message list into plain turns.
 * Structural on purpose: this file does not import pi.
 */
import type { ConversationTurn } from "./types";

interface LooseBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

interface LooseMessage {
  role?: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
}

function blockText(block: LooseBlock): string {
  if (block.type === "text" || block.type === "thinking") return block.text ?? "";
  if (block.type === "toolCall") {
    const args = block.arguments === undefined ? "" : ` ${JSON.stringify(block.arguments)}`;
    return `tool ${block.name ?? "?"}${args}`;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" ? blockText(block as LooseBlock) : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

export function turnsFromMessages(messages: readonly LooseMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    const text = contentText(message.content);
    if (!text) continue;
    if (message.role === "toolResult") {
      const name = message.toolName ?? "tool";
      turns.push({ role: message.isError ? `tool ${name} error` : `tool ${name}`, text });
      continue;
    }
    turns.push({ role: message.role ?? "message", text });
  }
  return turns;
}

export function formatConversation(turns: readonly ConversationTurn[]): string {
  if (turns.length === 0) return "(no messages yet)";
  return turns.map((turn) => `── ${turn.role} ──\n${turn.text}`).join("\n\n");
}
