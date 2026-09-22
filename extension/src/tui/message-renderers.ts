/**
 * Custom message renderers for PBS notifications (Claude-style compact pills).
 *
 * Uses `@earendil-works/pi-tui` Box/Text when resolvable (via the host pi
 * package); otherwise falls back to a plain multi-line text component so
 * print-mode / unit tests still work.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPiTui as loadSharedPiTui } from "./pi-tui-load";
import { SUPERVISOR_NOTIFICATION_CUSTOM_TYPE } from "../comms/registry-host";
import { MONITOR_EVENT_CUSTOM_TYPE } from "../monitor";
import { TASK_NOTIFICATION_CUSTOM_TYPE } from "../notify";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../subagent/tool";

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};

type PiTui = {
  Box: new (
    pad: number,
    gap: number,
    bg: (t: string) => string,
  ) => { addChild(c: unknown): void };
  Text: new (text: string, padX: number, padY: number) => unknown;
};

function loadPiTui(): PiTui | null {
  return loadSharedPiTui() as PiTui | null;
}

function asText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("\n");
  }
  return String(content ?? "");
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text.trim();
}

function stripXml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function makeBox(tui: PiTui | null, pad: number, theme: Theme, text: string): unknown {
  if (!tui) {
    return { render: () => text.split("\n") };
  }
  const box = new tui.Box(pad, 1, (s) => theme.bg("customMessageBg", s));
  box.addChild(new tui.Text(text, 0, 0));
  return box;
}

export function registerPbsMessageRenderers(pi: ExtensionAPI): void {
  const tui = loadPiTui();

  pi.registerMessageRenderer(TASK_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const summary =
      extractTag(content, "summary") || truncate(stripXml(content), 120) || "Background task finished";
    const head = `${theme.fg("success", "✓")} ${theme.fg("muted", "task")} ${summary}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeBox(tui, outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const summary =
      extractTag(content, "summary") || truncate(stripXml(content), 120) || "Subagent run finished";
    const status = extractTag(content, "status") ?? "";
    const color =
      status === "failed" || status === "interrupted" ? "error" : status === "partial" ? "warning" : "success";
    const glyph = color === "error" ? "✗" : color === "warning" ? "■" : "✓";
    const head = `${theme.fg(color, glyph)} ${theme.fg("muted", "subagent")} ${summary}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeBox(tui, outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(MONITOR_EVENT_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const details = message.details as { description?: string; status?: string } | undefined;
    const desc =
      details?.description ??
      content.match(/description="([^"]*)"/)?.[1] ??
      content.match(/Monitor event: "([^"]*)"/)?.[1] ??
      "monitor";
    const status = details?.status;
    const eventBody =
      extractTag(content, "event") ??
      firstLine(
        stripXml(content)
          .replace(/Monitor event:\s*"[^"]*"\s*/i, "")
          .trim(),
      );
    const preview = truncate(eventBody || "(event)", 120);
    // Claude Code lead-in: Monitor event: "description"
    const lead = `${theme.fg("accent", "●")} ${theme.fg("muted", "Monitor event:")} ${theme.fg("accent", `"${desc}"`)}`;
    const statusBit = status ? ` ${theme.fg("dim", `· ${status}`)}` : "";
    const head = `${lead}${statusBit}\n${theme.fg("dim", preview)}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeBox(tui, outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(SUPERVISOR_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const isRequest = /supervisor-request/i.test(content);
    const label = isRequest ? "supervisor request" : "supervisor update";
    const color = isRequest ? "warning" : "muted";
    const glyph = isRequest ? "?" : "↑";
    const preview = truncate(stripXml(content), 100);
    const head = `${theme.fg(color, glyph)} ${theme.fg("muted", label)} ${preview}`;
    const hint =
      isRequest && !expanded
        ? `\n${theme.fg("dim", '  reply with agent_message { action:"reply", to, message }')}`
        : "";
    const body = expanded ? `\n${theme.fg("dim", content)}` : hint;
    return makeBox(tui, outputPad, theme, head + body) as never;
  });
}
