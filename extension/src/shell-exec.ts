/**
 * Shared bash helpers used by the parent override and the child-session bash.
 * Previously copied in both files.
 */
import type { BashToolDetails } from "@earendil-works/pi-coding-agent";
import { truncateTail } from "./format";
import type { ManagerClient } from "./manager-client";

export const SHELL_MAX_LINES = 2000;
export const SHELL_MAX_BYTES = 51200;
export const SHELL_OUTPUT_WINDOW_BYTES = 512 * 1024;

export const BARE_SLEEP_PATTERNS: RegExp[] = [
  /^\s*sleep\s+\d/,
  /^\s*while\s+true\b/,
  /^\s*while\s+sleep\b/,
  /^\s*until\s+/,
];

export function bareSleepError(command: string, guidance: string): string | null {
  if (!BARE_SLEEP_PATTERNS.some((re) => re.test(command))) return null;
  return `Refusing to run a bare sleep/idle-loop command: ${JSON.stringify(command)}. ${guidance}`;
}

export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const handler = () => {
      onAbort();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", handler, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handler);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", handler);
        reject(err);
      },
    );
  });
}

export interface CollectedOutput {
  text: string;
  totalSize: number;
  windowed: boolean;
}

export async function collectOutput(client: ManagerClient, taskId: string): Promise<CollectedOutput> {
  const probe = await client.output(taskId, 0, 1);
  const totalSize = probe.total_size;
  const start = Math.max(0, totalSize - SHELL_OUTPUT_WINDOW_BYTES);
  let cursor = start;
  let text = "";
  for (;;) {
    const res = await client.output(taskId, cursor, SHELL_OUTPUT_WINDOW_BYTES);
    text += res.chunk;
    if (res.next_cursor <= cursor || res.next_cursor >= res.total_size) break;
    cursor = res.next_cursor;
  }
  return { text, totalSize, windowed: start > 0 };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface FormattedShellOutput {
  text: string;
  details: BashToolDetails | undefined;
}

export function formatFinishedOutput(raw: CollectedOutput, outputPath: string): FormattedShellOutput {
  const t = truncateTail(raw.text, SHELL_MAX_LINES, SHELL_MAX_BYTES);
  const truncated = t.truncated || raw.windowed;
  let text = t.text || "(no output)";
  if (!truncated) return { text, details: undefined };

  const outputLines = t.text.length === 0 ? 0 : t.text.split("\n").length;
  const outputBytes = Buffer.byteLength(t.text, "utf8");
  const truncatedBy = t.totalLines > SHELL_MAX_LINES ? "lines" : "bytes";
  const details: BashToolDetails = {
    truncation: {
      content: t.text,
      truncated: true,
      truncatedBy,
      totalLines: t.totalLines,
      totalBytes: raw.totalSize,
      outputLines,
      outputBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: SHELL_MAX_LINES,
      maxBytes: SHELL_MAX_BYTES,
    },
    fullOutputPath: outputPath,
  };
  const startLine = t.totalLines - outputLines + 1;
  const endLine = t.totalLines;
  if (truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines}. Full output: ${outputPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(SHELL_MAX_BYTES)} limit). Full output: ${outputPath}]`;
  }
  return { text, details };
}

export function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}
