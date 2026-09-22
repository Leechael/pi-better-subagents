/**
 * Custom message renderers for PBS notifications (Claude-style compact pills).
 *
 * Box is `(paddingX, paddingY, bgFn)` — the second argument is vertical padding,
 * not a child gap. `outputPad` is the horizontal pad (0 or 1), matching pi's
 * custom-message boxes which use `new Box(1, 1, bg)`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUPERVISOR_NOTIFICATION_CUSTOM_TYPE } from "../comms/registry-host";
import { MONITOR_EVENT_CUSTOM_TYPE } from "../monitor";
import { TASK_NOTIFICATION_CUSTOM_TYPE } from "../notify";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../subagent/tool";
import { fitLines, loadPiTui } from "./pi-tui-load";
import { statusGlyph } from "./tool-component";

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};

type PillComponent = {
  render(width: number): string[];
  invalidate(): void;
};

function asText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("\n");
  }
  return String(content ?? "");
}

function stripXml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractTag(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim();
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Real `<event>` body. The wake lead-in also mentions `<event>` inline — ignore that. */
export function extractMonitorEventBody(content: string): string {
  const block = content.match(/<event>\r?\n([\s\S]*?)\r?\n<\/event>/i);
  if (block) return block[1].trim();
  const tagged = extractTag(content, "event");
  if (tagged && !/^before other work/i.test(tagged)) return tagged;
  return "";
}

export function extractMonitorDescription(
  content: string,
  details?: { description?: string },
): string {
  if (details?.description) return details.description;
  const attr = content.match(/\bdescription="([^"]*)"/)?.[1];
  if (attr) return unescapeXml(attr);
  const modern = content.match(/Monitor event \(system wake[^)]*\):\s*"([^"]*)"/);
  if (modern) return modern[1];
  const legacy = content.match(/Monitor event:\s*"([^"]*)"/);
  if (legacy) return legacy[1];
  return "monitor";
}

function makeComponent(pad: number, theme: Theme, text: string): PillComponent {
  const tui = loadPiTui();
  if (tui) {
    // paddingX = outputPad, paddingY = 1 (blank line above/below), then bg.
    const box = new tui.Box(pad, 1, (s) => theme.bg("customMessageBg", s));
    box.addChild(new tui.Text(text, 0, 0));
    const rendered = box as unknown as { render(width: number): string[]; invalidate(): void };
    if (typeof rendered.invalidate !== "function") {
      rendered.invalidate = () => {};
    }
    return rendered;
  }
  return {
    render(width: number) {
      const inner = Math.max(1, width - pad * 2);
      const padStr = " ".repeat(Math.max(0, pad));
      return fitLines(text, inner).map((line) => padStr + line);
    },
    invalidate() {},
  };
}

export function registerPbsMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(TASK_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const status = extractTag(content, "status") ?? "";
    const summary =
      extractTag(content, "summary") || stripXml(content).slice(0, 120) || "Background task finished";
    const { color, glyph } = statusGlyph(status);
    const head = `${theme.fg(color as "error", glyph)} ${theme.fg("muted", "task")} ${summary}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeComponent(outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const summary =
      extractTag(content, "summary") || stripXml(content).slice(0, 120) || "Subagent run finished";
    const status = extractTag(content, "status") ?? "";
    const { color, glyph } = statusGlyph(status || "completed");
    const head = `${theme.fg(color as "error", glyph)} ${theme.fg("muted", "subagent")} ${summary}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeComponent(outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(MONITOR_EVENT_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const details = message.details as { description?: string; status?: string } | undefined;
    const desc = extractMonitorDescription(content, details);
    const status = details?.status ?? content.match(/\bstatus="([^"]*)"/)?.[1];
    const eventBody = extractMonitorEventBody(content) || "(event)";
    const preview = eventBody.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "(event)";
    const lead = `${theme.fg("accent", "●")} ${theme.fg("muted", "Monitor event:")} ${theme.fg("accent", `"${desc}"`)}`;
    const statusBit = status ? ` ${theme.fg("dim", `· ${status}`)}` : "";
    const head = `${lead}${statusBit}\n${theme.fg("dim", preview)}`;
    const body = expanded ? `\n${theme.fg("dim", content)}` : "";
    return makeComponent(outputPad, theme, head + body) as never;
  });

  pi.registerMessageRenderer(SUPERVISOR_NOTIFICATION_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = asText(message.content);
    const isRequest = /supervisor-request/i.test(content);
    const label = isRequest ? "supervisor request" : "supervisor update";
    const color = isRequest ? "warning" : "muted";
    const glyph = isRequest ? "?" : "↑";
    const preview = stripXml(content).slice(0, 100);
    const head = `${theme.fg(color, glyph)} ${theme.fg("muted", label)} ${preview}`;
    const hint =
      isRequest && !expanded
        ? `\n${theme.fg("dim", '  reply with agent_message { action:"reply", to, message }')}`
        : "";
    const body = expanded ? `\n${theme.fg("dim", content)}` : hint;
    return makeComponent(outputPad, theme, head + body) as never;
  });
}

