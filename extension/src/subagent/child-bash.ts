/**
 * Child-session bash variant (design doc §4.2 tail / §4.6).
 *
 * Registered as a custom tool named "bash" inside subagent sessions (it
 * overrides the built-in there). Differences from the main bash override:
 * - no run_in_background: subagents must not background work — the schema
 *   omits the flag entirely (lain waitUntilExit lesson);
 * - execute waits for the whole timeout via manager start + wait; on expiry
 *   the process is killed (SIGTERM->SIGKILL by the manager) and a timeout
 *   error is returned instead of backgrounding;
 * - bare sleep / idle-loop commands are rejected (same patterns as the main
 *   bash override; the detection logic is copied, not imported, per the M3
 *   file-ownership rules);
 * - no local fallback: when the manager is unavailable the tool fails with a
 *   clear error (subagent sessions are spawned by the extension where the
 *   manager is expected to be up).
 */
import { Type } from "typebox";
import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { taskOutputPath } from "../config";
import { truncateTail } from "../format";
import type { ManagerClient } from "../manager-client";

/** Same limits as the built-in bash tool. */
const MAX_LINES = 2000;
const MAX_BYTES = 51200;
/** Read window used when collecting finished task output. */
const OUTPUT_WINDOW_BYTES = 512 * 1024;
/** Wait granularity when no explicit timeout is given (abort responsiveness). */
const WAIT_SLICE_MS = 60_000;

const childBashParameters = Type.Object({
  command: Type.String({ description: "The bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Hard kill timeout in seconds (optional, no default timeout)" }),
  ),
});

type ChildBashParams = { command: string; timeout?: number };

export interface PbsChildBashDetails extends BashToolDetails {
  task_id?: string;
}

export interface ChildBashDeps {
  getClient: () => ManagerClient | null;
  home: string;
  /** Parent session id — the manager namespace this connection owns. */
  sessionId: () => string;
  /** Precomputed PI_* env injection (from the parent session). */
  sessionEnv: () => Record<string, string>;
  trackTask: (taskId: string, meta: { kind: string; command: string }) => void;
}

/**
 * Bare sleep / idle-loop patterns (§4.2). Copied from bash-override.ts —
 * private functions there must not be imported.
 */
const BARE_SLEEP_PATTERNS: RegExp[] = [
  /^\s*sleep\s+\d/,
  /^\s*while\s+true\b/,
  /^\s*while\s+sleep\b/,
  /^\s*until\s+/,
];

function bareSleepError(command: string): string | null {
  if (!BARE_SLEEP_PATTERNS.some((re) => re.test(command))) return null;
  return [
    `Refusing to run a bare sleep/idle-loop command: ${JSON.stringify(command)}.`,
    "Sleeping to wait for work is never useful: run the actual command directly,",
    "or report back to the supervisor if you are blocked.",
  ].join(" ");
}

function resolveTimeoutMs(timeoutSeconds: number | undefined): number | null {
  if (timeoutSeconds === undefined) return null;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  return Math.round(timeoutSeconds * 1000);
}

/** Race a promise against an AbortSignal; runs cleanup on abort. */
function withAbort<T>(
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

interface CollectedOutput {
  text: string;
  totalSize: number;
  /** True when only a tail window of the full output was read. */
  windowed: boolean;
}

/** Read the (finished) task output from the manager, tail-windowed. */
async function collectOutput(client: ManagerClient, taskId: string): Promise<CollectedOutput> {
  const probe = await client.output(taskId, 0, 1);
  const totalSize = probe.total_size;
  const start = Math.max(0, totalSize - OUTPUT_WINDOW_BYTES);
  let cursor = start;
  let text = "";
  for (;;) {
    const res = await client.output(taskId, cursor, OUTPUT_WINDOW_BYTES);
    text += res.chunk;
    if (res.next_cursor <= cursor || res.next_cursor >= res.total_size) break;
    cursor = res.next_cursor;
  }
  return { text, totalSize, windowed: start > 0 };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface FormattedOutput {
  text: string;
  details: PbsChildBashDetails | undefined;
}

/** Tail-truncate finished output and format it like the built-in bash tool. */
function formatFinishedOutput(raw: CollectedOutput, outputPath: string): FormattedOutput {
  const t = truncateTail(raw.text, MAX_LINES, MAX_BYTES);
  const truncated = t.truncated || raw.windowed;
  let text = t.text || "(no output)";
  if (!truncated) return { text, details: undefined };

  const outputLines = t.text.length === 0 ? 0 : t.text.split("\n").length;
  const outputBytes = Buffer.byteLength(t.text, "utf8");
  const truncatedBy = t.totalLines > MAX_LINES ? "lines" : "bytes";
  const details: PbsChildBashDetails = {
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
      maxLines: MAX_LINES,
      maxBytes: MAX_BYTES,
    },
    fullOutputPath: outputPath,
  };
  const startLine = t.totalLines - outputLines + 1;
  const endLine = t.totalLines;
  if (truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines}. Full output: ${outputPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(MAX_BYTES)} limit). Full output: ${outputPath}]`;
  }
  return { text, details };
}

function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

function fullEnv(deps: ChildBashDeps): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, deps.sessionEnv());
  return env;
}

export function createChildBashTool(
  deps: ChildBashDeps,
): ToolDefinition<typeof childBashParameters, PbsChildBashDetails | undefined> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. " +
      `Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
      "The command runs to completion (or the optional timeout in seconds, after which it is killed). " +
      "There is no background execution inside subagents.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    parameters: childBashParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const input = params as ChildBashParams;

      const sleepError = bareSleepError(input.command);
      if (sleepError) throw new Error(sleepError);

      const client = deps.getClient();
      if (!client || !(await client.ensureAvailable())) {
        throw new Error("pbs-manager is not available; bash is disabled inside this subagent");
      }

      const timeoutMs = resolveTimeoutMs(input.timeout);
      const start = await client.start({
        kind: "shell",
        command: input.command,
        cwd: ctx.cwd,
        env: fullEnv(deps),
        run_in_background: false,
        timeout_ms: timeoutMs,
      });
      deps.trackTask(start.task_id, { kind: "shell", command: input.command });
      const outputPath = taskOutputPath(deps.home, deps.sessionId(), start.task_id);

      const deadline = timeoutMs !== null ? Date.now() + timeoutMs : null;
      let waitResult: { done: boolean; exit_code?: number | null } | null = null;
      for (;;) {
        const budget =
          deadline === null
            ? WAIT_SLICE_MS
            : Math.min(WAIT_SLICE_MS, Math.max(1, deadline - Date.now()));
        try {
          waitResult = await withAbort(client.wait(start.task_id, budget), signal, () => {
            client.stop(start.task_id).catch(() => {});
          });
        } catch (err) {
          if ((err as Error).message === "aborted") {
            throw new Error("Command aborted (task stopped)");
          }
          throw new Error(
            `Lost contact with pbs-manager while waiting for task ${start.task_id}: ` +
              `${(err as Error).message}. Output so far: ${outputPath}.`,
          );
        }
        if (waitResult.done) break;
        if (deadline !== null && Date.now() >= deadline) {
          await client.stop(start.task_id).catch(() => {});
          const collected = await collectOutput(client, start.task_id).catch(() => null);
          const text = collected ? formatFinishedOutput(collected, outputPath).text : "";
          throw new Error(
            appendStatus(text, `Command timed out after ${input.timeout} seconds and was killed`),
          );
        }
      }

      const collected = await collectOutput(client, start.task_id);
      const { text, details } = formatFinishedOutput(collected, outputPath);
      const exitCode = waitResult.exit_code ?? null;
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
      }
      const finalDetails = details
        ? { ...details, task_id: start.task_id }
        : ({ task_id: start.task_id } as PbsChildBashDetails);
      return { content: [{ type: "text", text }], details: finalDetails };
    },
  };
}
