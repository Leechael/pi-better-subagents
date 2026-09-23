/**
 * Custom message renderers for PBS notifications (Claude-style compact pills).
 *
 * Box is `(paddingX, paddingY, bgFn)` — the second argument is vertical padding,
 * not a child gap. `outputPad` is the horizontal pad (0 or 1), matching pi's
 * custom-message boxes which use `new Box(1, 1, bg)`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PBS_WAKE_CUSTOM_TYPE, type PbsWake, type TaskWake } from "../wake";
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

const STATUS_ORDER = [
  "completed",
  "failed",
  "interrupted",
  "killed",
  "orphaned",
  "pending",
  "running",
  "partial",
  "timeout",
  "stopped",
];

function countStatuses(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  const parts = STATUS_ORDER.filter((status) => counts.has(status)).map(
    (status) => `${counts.get(status)} ${status}`,
  );
  return parts.join(" · ");
}

function badExit(status: string | undefined, exitCode?: number | null): boolean {
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return true;
  return status === "failed" || status === "killed" || status === "orphaned" || status === "interrupted";
}

function taskHead(tasks: TaskWake[]): string {
  if (tasks.length <= 1) return tasks[0]?.summary || "Background task finished";
  return `${tasks.length} tasks · ${countStatuses(tasks.map((task) => task.status))}`;
}

function collapsedText(details: PbsWake, theme: Theme): string {
  switch (details.kind) {
    case "task": {
      const bad = details.tasks.some((task) => badExit(task.status, task.exitCode));
      const { color, glyph } = statusGlyph(bad ? "failed" : "completed");
      return `${theme.fg(color, glyph)} ${theme.fg("muted", "task")} ${taskHead(details.tasks)}`;
    }
    case "monitor": {
      const preview = details.event.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(event)";
      const { color, glyph } = statusGlyph(details.status);
      const statusBit = details.status ? ` ${theme.fg("dim", `· ${details.status}`)}` : "";
      const countBit = details.eventCount && details.eventCount > 1
        ? ` ${theme.fg("dim", `· ${details.eventCount} events`)}`
        : "";
      const droppedBit = details.droppedLines
        ? ` ${theme.fg("warning", `· ${details.droppedLines} lines dropped`)}`
        : "";
      return `${theme.fg(color, glyph)} ${theme.fg("muted", "monitor")} ${theme.fg("accent", `"${details.description}"`)}${statusBit}${countBit}${droppedBit}\n${theme.fg("dim", preview)}`;
    }
    case "subagent-handover": {
      const { color, glyph } = statusGlyph(details.status);
      return `${theme.fg(color, glyph)} ${theme.fg("muted", "handover")} ${details.name} ${details.status}`;
    }
    case "subagent-done": {
      const bad = details.children.some((child) => badExit(child.status));
      const { color, glyph } = statusGlyph(bad ? "failed" : details.status);
      return `${theme.fg(color, glyph)} ${theme.fg("muted", "subagent")} ${countStatuses(details.children.map((child) => child.status))}`;
    }
    case "supervisor-request":
      return [
        `${theme.fg("warning", "?")} ${theme.fg("muted", "supervisor request")} ${details.message.slice(0, 100)}`,
        theme.fg("dim", 'reply with agent_message { action:"reply", to, message }'),
      ].join("\n");
    case "supervisor-update":
      return `${theme.fg("muted", "↑")} ${theme.fg("muted", "supervisor update")} ${details.message.slice(0, 100)}`;
  }
}

function wakeDetails(message: { details?: unknown }): PbsWake | undefined {
  const details = message.details as PbsWake | undefined;
  if (!details || typeof details !== "object" || !("kind" in details)) return undefined;
  return details;
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
  pi.registerMessageRenderer(PBS_WAKE_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = wakeDetails(message);
    const content = typeof message.content === "string" ? message.content : "";
    const head = details ? collapsedText(details, theme) : theme.fg("muted", "wake");
    const body = expanded && content ? `\n${theme.fg("dim", content)}` : "";
    return makeComponent(outputPad, theme, head + body) as never;
  });
}

