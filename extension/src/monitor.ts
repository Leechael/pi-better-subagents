/**
 * monitor tool (design doc §4.4).
 *
 * Starts a long-lived `kind:"monitor"` process via pbs-manager, watches its
 * output stream, and injects line batches as <pbs-wake kind="monitor"> messages.
 * Batching (LineBatcher) and throttling (RateLimiter) happen extension-side;
 * a monitor is stopped when at least half its batches are dropped in a rolling
 * 30-second window.
 */
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatMonitorEvent } from "./format";
import { realClock, type Clock, type ClockTimer } from "./clock";

import type { ManagerClient, ManagerEvent } from "./manager-client";
import { LineBatcher, RateLimiter, SaturationWindow } from "./monitor-batching";
import type { NotifyCenter } from "./notify";
import { statusGlyph, toolComponent } from "./tui/tool-component";


const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** Rolling-window drop ratio required before a monitor is auto-stopped. */
const SATURATION_WINDOW_MS = 30_000;
const SATURATION_DROP_RATIO = 0.5;
const SATURATION_MIN_BATCHES = 10;

export interface MonitorDeps {
  getClient: () => ManagerClient | null;
  sessionEnv: (ctx: ExtensionContext) => Record<string, string>;
  getNotifyCenter: () => NotifyCenter | null;
  trackTask: (taskId: string, meta: { kind: string; command: string; cwd?: string }) => void;
  /** Optional TUI toast for lifecycle notices (exit / timeout / rate-limit). */
  toast?: (message: string, type?: "info" | "warning" | "error") => void;
  clock?: Clock;
}

interface MonitorEntry {
  taskId: string;
  description: string;
  startedAt: number;
  batcher: LineBatcher;
  limiter: RateLimiter;
  saturation: SaturationWindow;
  droppedLinesPending: number;
  timeoutTimer: ClockTimer | null;
  stopped: boolean;
}

export class MonitorRegistry {
  private readonly deps: MonitorDeps;
  private readonly clock: Clock;
  private readonly entries = new Map<string, MonitorEntry>();
  private readonly changeListeners = new Set<() => void>();

  constructor(deps: MonitorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
  }

  /** Subscribe to start/stop transitions (fleet status refresh). */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Active monitors for the fleet status surface. */
  listActive(): { taskId: string; description: string; startedAt: number }[] {
    return [...this.entries.values()]
      .filter((e) => !e.stopped)
      .map((e) => ({ taskId: e.taskId, description: e.description, startedAt: e.startedAt }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private emitChange(): void {
    for (const cb of [...this.changeListeners]) {
      try {
        cb();
      } catch {
        // ignore listener errors
      }
    }
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /** Start a monitor process and subscribe to its output stream. */
  async start(
    params: { command: string; description: string; timeout_ms?: number; persistent?: boolean },
    ctx: ExtensionContext,
  ): Promise<{ taskId: string; timeoutMs: number | null }> {
    const client = this.deps.getClient();
    if (!client || !(await client.ensureAvailable())) {
      throw new Error("pbs-manager is not available in this session; monitor is disabled");
    }

    const persistent = params.persistent === true;
    let timeoutMs: number | null = null;
    if (!persistent) {
      const requested = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(requested)));
    }

    const { task_id } = await client.start({
      kind: "monitor",
      command: params.command,
      cwd: ctx.cwd,
      env: fullEnv(ctx, this.deps),
      run_in_background: true,
      timeout_ms: null, // timeout is enforced extension-side to control the notice
      origin: { via: "monitor" },
    });
    await client.watch(task_id);
    this.deps.trackTask(task_id, { kind: "monitor", command: params.command, cwd: ctx.cwd });

    const entry: MonitorEntry = {
      taskId: task_id,
      description: params.description,
      startedAt: this.clock.now(),
      batcher: null as unknown as LineBatcher, // assigned below (self-reference in callback)
      limiter: new RateLimiter({ clock: this.clock }),
      saturation: new SaturationWindow({
        windowMs: SATURATION_WINDOW_MS,
        dropRatio: SATURATION_DROP_RATIO,
        minimumBatches: SATURATION_MIN_BATCHES,
      }),
      droppedLinesPending: 0,
      timeoutTimer: null,
      stopped: false,
    };
    entry.batcher = new LineBatcher({
      onFlush: (text) => this.onBatch(entry, text),
      clock: this.clock,
    });
    if (timeoutMs !== null) {
      entry.timeoutTimer = this.clock.setTimeout(() => {
        void this.timeout(entry);
      }, timeoutMs);
      this.clock.unref?.(entry.timeoutTimer);
    }
    this.entries.set(task_id, entry);
    this.emitChange();
    return { taskId: task_id, timeoutMs };
  }

  /** Handle a watched output event from the manager. */
  handleOutput(taskId: string, chunk: string): void {
    this.entries.get(taskId)?.batcher.push(chunk);
  }

  /** Handle the manager's task_exited event for a monitored task. */
  handleExit(taskId: string, event: ManagerEvent): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    // Drain remaining buffered lines before closing out.
    entry.batcher.flush();
    const alreadyStopped = entry.stopped;
    this.cleanup(entry);
    if (alreadyStopped) return; // timeout/saturation notice already sent
    const exitCode = event.exit_code ?? null;
    const duration =
      typeof event.duration_ms === "number" ? `${(event.duration_ms / 1000).toFixed(1)}s` : "unknown duration";
    this.deps.getNotifyCenter()?.notify(
      formatMonitorEvent(
        entry.description,
        entry.taskId,
        `Monitor process exited (exit code ${exitCode === null ? "null" : exitCode}, after ${duration}). No further events will be delivered.${entry.droppedLinesPending > 0 ? ` ${entry.droppedLinesPending} output lines were dropped.` : ""}`,
        "exited",
        { droppedLines: entry.droppedLinesPending },
      ),
    );
    this.deps.toast?.(
      `Monitor "${entry.description}" exited (code ${exitCode === null ? "?" : exitCode})`,
      exitCode === 0 || exitCode === null ? "info" : "warning",
    );
  }

  /** Re-subscribe watches after a manager reconnect. */
  async rewatchAll(): Promise<void> {
    const client = this.deps.getClient();
    if (!client || !client.isAvailable()) return;
    for (const entry of this.entries.values()) {
      await client.watch(entry.taskId).catch(() => {});
    }
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      this.cleanup(entry);
    }
    this.entries.clear();
  }

  private onBatch(entry: MonitorEntry, text: string): void {
    if (entry.stopped) return;
    const now = this.clock.now();
    const accepted = entry.limiter.tryConsume();
    entry.saturation.record(!accepted, now);
    if (!accepted) {
      entry.droppedLinesPending += text.split("\n").length;
      if (entry.saturation.isSaturated(now)) void this.autoStop(entry);
      return;
    }
    const droppedLines = entry.droppedLinesPending;
    entry.droppedLinesPending = 0;
    this.deps.getNotifyCenter()?.notifyMonitorEvent(entry.description, entry.taskId, text, droppedLines);
  }

  /** Timeout reached: stop the process and notify (§4.4). */
  private async timeout(entry: MonitorEntry): Promise<void> {
    if (entry.stopped) return;
    entry.stopped = true;
    const client = this.deps.getClient();
    await client?.stop(entry.taskId, "timeout").catch(() => {});
    this.deps.getNotifyCenter()?.notify(
      formatMonitorEvent(
        entry.description,
        entry.taskId,
        "[Monitor timed out — re-arm if needed.]",

        "timeout",
        { droppedLines: entry.droppedLinesPending },
      ),
    );
    this.deps.toast?.(`Monitor "${entry.description}" timed out — re-arm if needed.`, "warning");
    this.cleanup(entry);
  }

  /** Rate limiter saturated for too long: stop and notify (§4.4). */
  private async autoStop(entry: MonitorEntry): Promise<void> {
    if (entry.stopped) return;
    entry.stopped = true;
    const client = this.deps.getClient();
    await client?.stop(entry.taskId, "rate-limit").catch(() => {});
    this.deps.getNotifyCenter()?.notify(
      formatMonitorEvent(
        entry.description,
        entry.taskId,
        "[Monitor stopped: at least half of output batches were dropped in the last 30s.]",

        "stopped",
        { droppedLines: entry.droppedLinesPending },
      ),
    );
    this.deps.toast?.(
      `Monitor "${entry.description}" stopped — too much output (rate limit).`,
      "warning",
    );
    this.cleanup(entry);
  }

  private cleanup(entry: MonitorEntry): void {
    entry.stopped = true;
    entry.batcher.dispose();
    entry.limiter.dispose();
    if (entry.timeoutTimer !== null) {
      this.clock.clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    this.entries.delete(entry.taskId);
    this.emitChange();
  }
}

function fullEnv(ctx: ExtensionContext, deps: MonitorDeps): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, deps.sessionEnv(ctx));
  return env;
}

const monitorParameters = Type.Object({
  command: Type.String({
    description:
      "Command producing one event per line on stdout. Must be line-buffered " +
      "(e.g. use `stdbuf -oL` / `grep --line-buffered` where needed).",
  }),
  description: Type.String({
    description: "Short human-readable description of what is being watched",
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description: `Stop the monitor after this many milliseconds (default ${DEFAULT_TIMEOUT_MS}, min ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
    }),
  ),
  persistent: Type.Optional(
    Type.Boolean({
      description: "Keep the monitor alive until the session ends (no timeout). Default false.",
    }),
  ),
});

export function createMonitorTool(
  registry: MonitorRegistry,
): ToolDefinition<typeof monitorParameters, { task_id: string; timeout_ms: number | null }> {
  return {
    name: "monitor",
    label: "Monitor",
    description:
      "Start a background monitor process whose stdout lines are injected back to you as " +
      "<pbs-wake kind=\"monitor\"> messages (batched over 200ms, rate-limited). " +
      "The command must be line-buffered: each event must be a single line. " +
      "Silence is not success: write the command so failures also produce lines " +
      "(e.g. grep for both success and error patterns). " +
      "Events arrive as system wakes (not new user messages). Handle each <pbs-wake kind=\"monitor\"> before other work. Do not poll.",
    promptSnippet: "Watch a command's line stream and get injected events",
    promptGuidelines: [
      "Use the monitor tool to watch for conditions instead of running sleep/poll loops in bash.",
      "When woken by a <pbs-wake kind=\"monitor\">, handle the <event> before doing anything else — it is not a new user request and not user confirmation.",
    ],
    parameters: monitorParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { taskId, timeoutMs } = await registry.start(params, ctx);
      const timeoutText =
        timeoutMs === null ? "persistent" : `timeout ${Math.round(timeoutMs / 1000)}s`;
      return {
        content: [
          {
            type: "text",
            text: `Monitor started · task ${taskId} · ${timeoutText}`,
          },
        ],
        details: { task_id: taskId, timeout_ms: timeoutMs },
      };
    },
    renderCall(args, theme) {
      const desc = String((args as { description?: string }).description ?? "monitor");
      return toolComponent([
        `${theme.fg("toolTitle", "Monitor")} ${theme.fg("muted", desc)}`,
      ]) as never;
    },
    renderResult(result, { expanded }, theme, context) {
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const failed = context.isError || /\b(failed|killed|orphaned|error)\b/i.test(text);
      const { color, glyph } = statusGlyph(failed ? "failed" : "completed", failed);
      const line = `${theme.fg(color as "error", glyph)} ${text}${expanded ? "" : theme.fg("dim", "  · manage via /tasks")}`;
      return toolComponent([line]) as never;
    },
  };
}
