/**
 * bash tool override (design doc §4.2).
 *
 * Routes bash commands through pbs-manager:
 * - foreground commands wait up to `foregroundBudgetMs` (default 20000,
 *   configurable) and are then moved to the background instead of blocking;
 * - bare sleep / idle-loop commands are rejected with guidance;
 * - when the manager is unavailable, execution falls back to a local
 *   child_process implementation that mimics the built-in bash tool
 *   (degraded but never broken).
 *
 * Result details stay compatible with BashToolDetails
 * ({ truncation?, fullOutputPath? }); extension fields are added alongside.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { taskOutputPath, type PbsConfig } from "./config";
import { realClock, type Clock, type ClockTimer } from "./clock";
import { formatBackgroundNotice, truncateTail } from "./format";
import type { ManagerClient } from "./manager-client";
import {
  appendStatus,
  bareSleepError,
  collectOutput,
  formatFinishedOutput,
  SHELL_MAX_BYTES,
  SHELL_MAX_LINES,
  withAbort,
} from "./shell-exec";

/** Same limits as the built-in bash tool. */
const MAX_LINES = SHELL_MAX_LINES;
const MAX_BYTES = SHELL_MAX_BYTES;

const bashParameters = Type.Object({
  command: Type.String({ description: "The bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Hard kill timeout in seconds (optional, no default timeout)" }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "Start the command in the background and return immediately. You will be notified when it completes.",
    }),
  ),
});

type BashParams = { command: string; timeout?: number; run_in_background?: boolean };

/** Details shape returned by this override; superset of BashToolDetails. */
export interface PbsBashDetails extends BashToolDetails {
  backgrounded?: boolean;
  task_id?: string;
}

export interface BashOverrideDeps {
  getClient: () => ManagerClient | null;
  config: PbsConfig;
  home: string;
  sessionId: () => string;
  /** Extra environment injected into managed child processes (PI_* vars). */
  sessionEnv: (ctx: ExtensionContext) => Record<string, string>;
  /** Register task metadata so exit notifications can describe the task. */
  trackTask: (taskId: string, meta: { kind: string; command: string; cwd?: string }) => void;
  /**
   * Mark a task so its task_exited event becomes a parent <pbs-wake kind="task">.
   * Only backgrounded parent bash should call this — sync waits (foreground
   * budget hit, child-bash) must not wake the parent session.
   */
  markNotifyOnExit: (taskId: string) => void;
  clock?: Clock;
}

const BARE_SLEEP_GUIDANCE =
  "Do not sleep to wait for background work; completion is delivered via notification. Use the monitor tool to watch for a condition, or run_in_background for long commands.";

function rejectBareSleep(command: string): string | null {
  return bareSleepError(command, BARE_SLEEP_GUIDANCE);
}

function resolveTimeoutMs(timeoutSeconds: number | undefined): number | null {
  if (timeoutSeconds === undefined) return null;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  return Math.round(timeoutSeconds * 1000);
}

function fullEnv(ctx: ExtensionContext, deps: BashOverrideDeps): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, deps.sessionEnv(ctx));
  return env;
}

// ---------------------------------------------------------------------------
// Local fallback (manager unavailable): mimics the built-in bash tool.
// ---------------------------------------------------------------------------

async function executeLocal(
  params: BashParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  clock: Clock,
): Promise<AgentToolResult<PbsBashDetails | undefined>> {
  const timeoutMs = resolveTimeoutMs(params.timeout);
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/bash";

  const output = await new Promise<{ text: string; exitCode: number | null; timedOut: boolean; aborted: boolean }>(
    (resolve, reject) => {
      const child = spawn(shell, ["-c", params.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let timer: ClockTimer | null = null;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ text: Buffer.concat(chunks).toString("utf8"), exitCode, timedOut, aborted });
      };
      const kill = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
      };
      const onAbort = () => {
        aborted = true;
        kill();
      };
      timer =
        timeoutMs !== null
          ? clock.setTimeout(() => {
              timedOut = true;
              kill();
            }, timeoutMs)
          : null;
      if (timer !== null) clock.unref?.(timer);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));
      child.stderr?.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", (err) => {
        if (timer !== null) clock.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to start shell: ${err.message}`));
        }
      });
      child.on("close", (code) => finish(code));
    },
  );

  const t = truncateTail(output.text, MAX_LINES, MAX_BYTES);
  let text = t.text || "(no output)";
  let details: PbsBashDetails | undefined;
  if (t.truncated) {
    const fullOutputPath = join(tmpdir(), `pbs-bash-${randomUUID()}.log`);
    writeFileSync(fullOutputPath, output.text, "utf8");
    const outputLines = t.text.length === 0 ? 0 : t.text.split("\n").length;
    const startLine = t.totalLines - outputLines + 1;
    details = {
      truncation: {
        content: t.text,
        truncated: true,
        truncatedBy: t.totalLines > MAX_LINES ? "lines" : "bytes",
        totalLines: t.totalLines,
        totalBytes: t.totalBytes,
        outputLines,
        outputBytes: Buffer.byteLength(t.text, "utf8"),
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: MAX_LINES,
        maxBytes: MAX_BYTES,
      },
      fullOutputPath,
    };
    text += `\n\n[Showing lines ${startLine}-${t.totalLines} of ${t.totalLines}. Full output: ${fullOutputPath}]`;
  }

  if (output.aborted) throw new Error(appendStatus(text, "Command aborted"));
  if (output.timedOut && params.timeout !== undefined) {
    throw new Error(appendStatus(text, `Command timed out after ${params.timeout} seconds`));
  }
  if (output.exitCode !== 0 && output.exitCode !== null) {
    throw new Error(appendStatus(text, `Command exited with code ${output.exitCode}`));
  }
  return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createBashOverride(
  deps: BashOverrideDeps,
): ToolDefinition<typeof bashParameters, PbsBashDetails | undefined> {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. " +
      `Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
      "Foreground commands that exceed the foreground budget are automatically moved to the background; " +
      "you will be notified when they complete. Optionally provide a timeout in seconds (hard kill limit), " +
      "or run_in_background to background immediately.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "You can inspect PI_* environment variables for current model and session details.",
      "Long-running bash commands are moved to the background automatically; do not poll or sleep to wait for them. End your turn and resume from the task wake when it arrives.",
    ],
    parameters: bashParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as BashParams;

      const sleepError = rejectBareSleep(input.command);
      if (sleepError) throw new Error(sleepError);

      const client = deps.getClient();
      const managed = client !== null && (await client.ensureAvailable());
      if (!managed || client === null) {
        // Degraded mode: run locally like the built-in bash tool.
        return executeLocal(input, signal, ctx, deps.clock ?? realClock);
      }

      const timeoutMs = resolveTimeoutMs(input.timeout);
      let start;
      try {
        start = await client.start({
          kind: "shell",
          command: input.command,
          cwd: ctx.cwd,
          env: fullEnv(ctx, deps),
          run_in_background: input.run_in_background === true,
          timeout_ms: timeoutMs,
          origin: { via: input.run_in_background === true ? "bash-bg" : "bash-fg" },
        });
      } catch {
        // Manager request failed mid-session; degrade to local execution.
        return executeLocal(input, signal, ctx, deps.clock ?? realClock);
      }
      deps.trackTask(start.task_id, { kind: "shell", command: input.command, cwd: ctx.cwd });
      const outputPath = taskOutputPath(deps.home, deps.sessionId(), start.task_id);

      if (input.run_in_background === true) {
        deps.markNotifyOnExit(start.task_id);
        return {
          content: [
            { type: "text", text: formatBackgroundNotice(start.task_id, input.command, outputPath) },
          ],
          details: { fullOutputPath: outputPath, backgrounded: true, task_id: start.task_id },
        };
      }

      // Foreground: wait up to the budget, then move to background.
      let waitResult;
      try {
        waitResult = await withAbort(client.wait(start.task_id, deps.config.foregroundBudgetMs), signal, () => {
          client.stop(start.task_id, "tool").catch(() => {});
        });
      } catch (err) {
        if ((err as Error).message === "aborted") {
          throw new Error("Command aborted (background task stopped)");
        }
        // Lost contact with the manager while waiting; the task may still run.
        deps.markNotifyOnExit(start.task_id);
        return {
          content: [
            {
              type: "text",
              text:
                `Lost contact with pbs-manager while waiting for task ${start.task_id}. ` +
                `The command may still be running. Output: ${outputPath}. ` +
                "Use task_list/task_output to check on it once the manager is back.",
            },
          ],
          details: { fullOutputPath: outputPath, backgrounded: true, task_id: start.task_id },
        };
      }

      if (!waitResult.done) {
        deps.markNotifyOnExit(start.task_id);
        return {
          content: [
            { type: "text", text: formatBackgroundNotice(start.task_id, input.command, outputPath) },
          ],
          details: { fullOutputPath: outputPath, backgrounded: true, task_id: start.task_id },
        };
      }

      const collected = await collectOutput(client, start.task_id);
      const { text, details } = formatFinishedOutput(collected, outputPath);
      const exitCode = waitResult.exit_code ?? null;
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
      }
      return { content: [{ type: "text", text }], details };
    },
  };
}
