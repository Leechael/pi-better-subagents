/**
 * Unified wake envelope (design doc §4.5).
 *
 * One customType, one lead-in, one <pbs-wake> element. details.kind is the
 * discriminator the renderer and the eval adapter both read.
 */

export const PBS_WAKE_CUSTOM_TYPE = "pbs-wake";

export const PBS_WAKE_LEAD_IN =
  "System wake — not a new user message. Handle this <pbs-wake> before other work.";

export interface WakeItem {
  id: string;
  title: string;
}

export interface TaskWake {
  id: string;
  taskKind: string;
  status: "completed" | "failed" | "killed" | "orphaned";
  summary: string;
  command: string;
  outputPath: string;
  preview: string;
  durationMs: number;
  exitCode: number | null;
  /** Signal name ("SIGTERM" | "SIGKILL"). Omitted when the exit had no signal. */
  signal?: string;
}

export interface SubagentDoneChild {
  childId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  prompt: string;
  result: string;
  error?: string;
}

export type PbsWake =
  | { kind: "task"; stillRunning: WakeItem[]; tasks: TaskWake[] }
  | {
      kind: "monitor";
      id: string;
      description: string;
      status?: string;
      event: string;
      eventCount?: number;
      droppedLines?: number;
    }
  | {
      kind: "subagent-handover";
      runId: string;
      childId: string;
      name: string;
      status: "completed" | "failed" | "interrupted";
      stillRunning: WakeItem[];
      summary: string;
      prompt: string;
      result: string;
      error?: string;
    }
  | {
      kind: "subagent-done";
      runId: string;
      status: "completed" | "partial" | "failed" | "interrupted";
      durationMs: number;
      summary: string;
      children: SubagentDoneChild[];
    }
  | { kind: "supervisor-request"; from: string; name: string; message: string }
  | { kind: "supervisor-update"; from: string; name: string; message: string };

export interface FormattedWake {
  customType: typeof PBS_WAKE_CUSTOM_TYPE;
  content: string;
  details: PbsWake;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(text: string): string {
  return escapeXml(text).replace(/"/g, "&quot;");
}

/** Shell still-running title: one line, capped at 80 characters. */
export function shellWakeTitle(command: string): string {
  const one = command.replace(/\s+/g, " ").trim();
  if (one.length <= 80) return one;
  return `${one.slice(0, 79)}…`;
}

export function formatPbsWake(details: PbsWake, leadIn: string = PBS_WAKE_LEAD_IN): FormattedWake {
  const xml = renderWake(details);
  const content = leadIn ? `${leadIn}\n\n${xml}` : xml;
  return { customType: PBS_WAKE_CUSTOM_TYPE, content, details };
}

function renderWake(details: PbsWake): string {
  switch (details.kind) {
    case "task":
      return renderTask(details);
    case "monitor":
      return renderMonitor(details);
    case "subagent-handover":
      return renderHandover(details);
    case "subagent-done":
      return renderDone(details);
    case "supervisor-request":
      return renderRequest(details);
    case "supervisor-update":
      return renderUpdate(details);
  }
}

function stillRunningXml(items: WakeItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => `    <item id="${escapeXmlAttr(item.id)}">${escapeXml(item.title)}</item>`);
  return ["  <still-running>", ...lines, "  </still-running>"].join("\n");
}

function renderTask(details: Extract<PbsWake, { kind: "task" }>): string {
  const parts = ['<pbs-wake kind="task">'];
  const still = stillRunningXml(details.stillRunning);
  if (still) parts.push(still);
  for (const task of details.tasks) {
    const attrs = [
      `id="${escapeXmlAttr(task.id)}"`,
      `kind="${escapeXmlAttr(task.taskKind)}"`,
      `status="${escapeXmlAttr(task.status)}"`,
      `duration-ms="${Math.round(task.durationMs)}"`,
    ];
    if (task.exitCode !== null) attrs.push(`exit-code="${task.exitCode}"`);
    if (task.signal) attrs.push(`signal="${escapeXmlAttr(task.signal)}"`);
    parts.push(`  <task ${attrs.join(" ")}>`);
    parts.push(`    <summary>${escapeXml(task.summary)}</summary>`);
    parts.push(`    <command>${escapeXml(task.command)}</command>`);
    parts.push(`    <output-file>${escapeXml(task.outputPath)}</output-file>`);
    parts.push(`    <preview>${escapeXml(task.preview)}</preview>`);
    parts.push("  </task>");
  }
  parts.push("</pbs-wake>");
  return parts.join("\n");
}

function renderMonitor(details: Extract<PbsWake, { kind: "monitor" }>): string {
  const attrs = [
    'kind="monitor"',
    `id="${escapeXmlAttr(details.id)}"`,
    `description="${escapeXmlAttr(details.description)}"`,
  ];
  if (details.status) attrs.push(`status="${escapeXmlAttr(details.status)}"`);
  if (details.eventCount !== undefined && details.eventCount > 1) attrs.push(`event-count="${details.eventCount}"`);
  if (details.droppedLines !== undefined && details.droppedLines > 0) {
    attrs.push(`dropped-lines="${details.droppedLines}"`);
  }
  return [`<pbs-wake ${attrs.join(" ")}>`, `  <event>${escapeXml(details.event)}</event>`, "</pbs-wake>"].join("\n");
}

function renderHandover(details: Extract<PbsWake, { kind: "subagent-handover" }>): string {
  const attrs = [
    'kind="subagent-handover"',
    `run-id="${escapeXmlAttr(details.runId)}"`,
    `child-id="${escapeXmlAttr(details.childId)}"`,
    `name="${escapeXmlAttr(details.name)}"`,
    `status="${escapeXmlAttr(details.status)}"`,
  ];
  const parts = [`<pbs-wake ${attrs.join(" ")}>`];
  const still = stillRunningXml(details.stillRunning);
  if (still) parts.push(still);
  parts.push(`  <summary>${escapeXml(details.summary)}</summary>`);
  parts.push(`  <prompt>${escapeXml(details.prompt)}</prompt>`);
  if (details.error) parts.push(`  <error>${escapeXml(details.error)}</error>`);
  parts.push(`  <result>${escapeXml(details.result)}</result>`);
  parts.push("</pbs-wake>");
  return parts.join("\n");
}

function renderDone(details: Extract<PbsWake, { kind: "subagent-done" }>): string {
  const attrs = [
    'kind="subagent-done"',
    `run-id="${escapeXmlAttr(details.runId)}"`,
    `status="${escapeXmlAttr(details.status)}"`,
    `duration-ms="${Math.round(details.durationMs)}"`,
  ];
  const parts = [`<pbs-wake ${attrs.join(" ")}>`, `  <summary>${escapeXml(details.summary)}</summary>`];
  for (const child of details.children) {
    parts.push(
      `  <child id="${escapeXmlAttr(child.childId)}" name="${escapeXmlAttr(child.name)}" status="${escapeXmlAttr(child.status)}">`,
    );
    parts.push(`    <prompt>${escapeXml(child.prompt)}</prompt>`);
    if (child.error) parts.push(`    <error>${escapeXml(child.error)}</error>`);
    parts.push(`    <result>${escapeXml(child.result)}</result>`);
    parts.push("  </child>");
  }
  parts.push("</pbs-wake>");
  return parts.join("\n");
}

function renderRequest(details: Extract<PbsWake, { kind: "supervisor-request" }>): string {
  const recipe = `agent_message { action: "reply", to: "${details.from}", message: "<your decision>" }`;
  return [
    `<pbs-wake kind="supervisor-request" from="${escapeXmlAttr(details.from)}" name="${escapeXmlAttr(details.name)}">`,
    `  <message>${escapeXml(details.message)}</message>`,
    `  <reply-with>${escapeXml(recipe)}</reply-with>`,
    "</pbs-wake>",
  ].join("\n");
}

function renderUpdate(details: Extract<PbsWake, { kind: "supervisor-update" }>): string {
  return [
    `<pbs-wake kind="supervisor-update" from="${escapeXmlAttr(details.from)}" name="${escapeXmlAttr(details.name)}">`,
    `  <message>${escapeXml(details.message)}</message>`,
    "</pbs-wake>",
  ].join("\n");
}
