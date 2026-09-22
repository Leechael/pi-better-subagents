/**
 * Pure formatting helpers (design doc Appendix A).
 *
 * These functions are the shared contract between implementation and tests.
 * Signatures must match Appendix A exactly.
 */

export interface TruncationInfo {
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Keep the tail of `text`, bounded by both maxLines and maxBytes
 * (defaults match the built-in bash tool: 2000 lines / 50KB).
 * Never splits a line, except when the final line alone exceeds maxBytes,
 * in which case its byte-tail is kept (UTF-8 lossy).
 */
export function truncateTail(
  text: string,
  maxLines: number = 2000,
  maxBytes: number = 51200,
): { text: string } & TruncationInfo {
  const totalBytes = byteLength(text);
  const lines = text.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { text, truncated: false, totalLines, totalBytes };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = byteLength(lines[i]) + (kept.length > 0 ? 1 : 0); // +1 for the joining newline
    if (kept.length >= maxLines || bytes + lineBytes > maxBytes) break;
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }
  if (kept.length === 0 && lines.length > 0) {
    // The final line alone exceeds maxBytes: keep its byte tail, aligned to a
    // UTF-8 code point boundary so no replacement character is surfaced.
    kept.push(byteTail(lines[lines.length - 1], maxBytes));
  }
  return { text: kept.join("\n"), truncated: true, totalLines, totalBytes };
}

/** Last `maxBytes` bytes of `text`, cut at a UTF-8 boundary (never mid-character). */
function byteTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // Skip continuation bytes (0b10xxxxxx) to land on a character boundary.
  while (start < buf.length && (buf[start] & 0b1100_0000) === 0b1000_0000) start++;
  return buf.subarray(start).toString("utf8");
}

export interface TaskExitInfo {
  taskId: string;
  kind: string;
  command: string;
  status: "completed" | "failed" | "killed" | "orphaned";
  exitCode: number | null;
  durationMs: number;
  outputPath: string;
  /** Pre-truncated by the caller to 4000 chars. */
  preview: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(text: string): string {
  return escapeXml(text).replace(/"/g, "&quot;");
}

/** Shorten a command for one-line display inside notifications. */
function displayCommand(command: string, maxChars = 80): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars - 1)}…`;
}

function statusPhrase(info: TaskExitInfo): string {
  const code = info.exitCode === null ? null : `exit code ${info.exitCode}`;
  switch (info.status) {
    case "completed":
      return code ? `completed (${code})` : "completed";
    case "failed":
      return code ? `failed (${code})` : "failed";
    case "killed":
      return "was killed";
    case "orphaned":
      return "was orphaned (manager restarted)";
  }
}

/** Lead-in so the model treats the injection as a wake to act on (Claude Code pattern). */
const TASK_NOTIFICATION_WAKE =
  "Background task update (system wake — not a new user message). " +
  "Handle each task-notification block below before anything else: read status and preview, " +
  "use task_output only if you need more than the preview, then continue the work that " +
  "depended on this command. Do not wait for further user input when the next step is clear.";

function formatOneTaskNotification(info: TaskExitInfo): string {
  const summary = `Background command "${displayCommand(info.command)}" ${statusPhrase(info)}`;
  return [
    "<task-notification>",
    `  <task-id>${escapeXml(info.taskId)}</task-id><kind>${escapeXml(info.kind)}</kind>`,
    `  <status>${info.status}</status>`,
    `  <summary>${escapeXml(summary)}</summary>`,
    `  <output-file>${escapeXml(info.outputPath)}</output-file>`,
    `  <preview>${escapeXml(info.preview)}</preview>`,
    `  <duration-ms>${Math.round(info.durationMs)}</duration-ms>`,
    "</task-notification>",
  ].join("\n");
}

/**
 * Format one or more task exit events as a single notification payload.
 * Multiple events are merged into a list of <task-notification> blocks (§4.5).
 * Prefixed with a wake instruction so idle→triggerTurn turns continue work.
 */
export function formatTaskNotification(events: TaskExitInfo[]): string {
  return [TASK_NOTIFICATION_WAKE, ...events.map(formatOneTaskNotification)].join("\n\n");
}

/** Tool-result text returned when a foreground command is moved to the background (§4.2). */
export function formatBackgroundNotice(
  taskId: string,
  command: string,
  outputPath: string,
): string {
  return [
    `Command "${displayCommand(command)}" moved to background (task_id: ${taskId}). Output: ${outputPath}.`,
    "You will be notified when it completes. Do not poll or sleep — end your turn and continue from the <task-notification> when it arrives.",
  ].join("\n");
}

/** Injected payload for a batch of monitor output lines (§4.4). */
export function formatMonitorEvent(
  description: string,
  taskId: string,
  batchText: string,
): string {
  // Claude Code shape: human lead-in + <event> body, wrapped in our
  // contractual <monitor-event> envelope so the model and the TUI pill agree.
  // Lead-in mirrors "If you were woken by a <task-notification>, handle the event…"
  return (
    `<monitor-event description="${escapeXmlAttr(description)}" task_id="${escapeXmlAttr(taskId)}">\n` +
    `Monitor event (system wake — not a new user message): "${description}". Handle <event> before other work.\n` +
    `<event>\n${batchText}\n</event>\n` +
    `</monitor-event>`
  );
}

// ---------------------------------------------------------------------------
// M3: subagent run completion notification (design doc §4.6)
// ---------------------------------------------------------------------------

export interface SubagentChildInfo {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  text: string;
  error?: string;
  /** Task prompt that was sent to this child. */
  prompt?: string;
}

export interface SubagentNotificationInfo {
  runId: string;
  status: "completed" | "partial" | "failed" | "interrupted";
  durationMs: number;
  children: SubagentChildInfo[];
}

/** Per-child result text is capped to its tail inside notifications (§4.6). */
const SUBAGENT_NOTIFICATION_CHILD_CHARS = 2000;

function capTail(text: string): string {
  return text.length > SUBAGENT_NOTIFICATION_CHILD_CHARS
    ? text.slice(-SUBAGENT_NOTIFICATION_CHILD_CHARS)
    : text;
}

/** Keep the start of a task prompt; the assignment is at the beginning. */
function capPrompt(text: string): string {
  return text.length > SUBAGENT_NOTIFICATION_CHILD_CHARS
    ? `${text.slice(0, SUBAGENT_NOTIFICATION_CHILD_CHARS)}…`
    : text;
}

export interface SubagentHandoverInfo {
  runId: string;
  childId: string;
  name: string;
  status: "completed" | "failed" | "interrupted";
  prompt: string;
  text: string;
  error?: string;
  /** Names of children that are still pending or running. */
  stillRunning: string[];
}

/**
 * Format a finished subagent run as a <subagent-notification> payload.
 * Each child contributes `## name (status)` plus the tail of its result text.
 */
export function formatSubagentNotification(info: SubagentNotificationInfo): string {
  const completed = info.children.filter((c) => c.status === "completed").length;
  const summary = `${completed}/${info.children.length} subagents completed in ${Math.round(info.durationMs)}ms`;
  const results = info.children
    .map((child) => {
      const tail = capTail(child.text);
      const errorLine = child.error ? `Error: ${child.error}\n` : "";
      const promptLine = child.prompt ? `Prompt: ${capPrompt(child.prompt)}\n` : "";
      return `## ${child.name} (${child.status})\n${promptLine}${errorLine}${tail}`;
    })
    .join("\n\n");
  return [
    "Subagent run finished (system wake — not a new user message). " +
      "Read <results>, synthesize findings, and continue your plan " +
      "(or use agent_message to follow up with a child). Do not merely acknowledge.",
    "<subagent-notification>",
    `  <run-id>${escapeXml(info.runId)}</run-id>`,
    `  <status>${info.status}</status>`,
    `  <summary>${escapeXml(summary)}</summary>`,
    `  <results>\n${escapeXml(results)}\n  </results>`,
    "</subagent-notification>",
  ].join("\n");
}

/**
 * One child finished while others in the same run are still going.
 * The parent must see the original prompt and the result, then keep working.
 */
export function formatSubagentHandover(info: SubagentHandoverInfo): string {
  const others =
    info.stillRunning.length === 0 ? "(none)" : info.stillRunning.join(", ");
  const summary = `${info.name} ${info.status}; ${info.stillRunning.length} still running`;
  const errorLine = info.error ? `Error: ${info.error}\n` : "";
  return [
    "Subagent handover (system wake — not a new user message). " +
      "One subagent finished while others are still running. " +
      "Read <prompt> and <result> now, then continue the work: " +
      "use agent_message to resume this child or steer the ones still running. " +
      "Do not wait for the rest of the run. Do not merely acknowledge.",
    "<subagent-handover>",
    `  <run-id>${escapeXml(info.runId)}</run-id>`,
    `  <child-id>${escapeXml(info.childId)}</child-id>`,
    `  <name>${escapeXml(info.name)}</name>`,
    `  <status>${info.status}</status>`,
    `  <summary>${escapeXml(summary)}</summary>`,
    `  <still-running>${escapeXml(others)}</still-running>`,
    `  <prompt>\n${escapeXml(capPrompt(info.prompt))}\n  </prompt>`,
    `  <result>\n${escapeXml(errorLine + capTail(info.text))}\n  </result>`,
    "</subagent-handover>",
  ].join("\n");
}
