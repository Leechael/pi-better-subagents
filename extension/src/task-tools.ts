/**
 * task_* tools (design doc §4.3): inspect and stop manager tasks.
 */
import { Type } from "typebox";
import { realClock, type Clock } from "./clock";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ManagerClient, TaskRecord } from "./manager-client";
import {
  formatAgentCommand,
  isAgentStatusActive,
  loadAgentChildRecords,
} from "./subagent/agent-records";
import type { SubagentRegistry } from "./subagent/registry";
import type { WorkIndex, WorkItem } from "./work-index";
import { formatAge } from "./work-index";

export interface TaskToolsDeps {
  getClient: () => ManagerClient | null;
  /** Optional: merge in-process subagent children into task_list (§4.3). */
  getRegistry?: () => SubagentRegistry | null;
  /** Fleet /tasks / task_list share this index when present. */
  getIndex?: () => WorkIndex | null;
  home?: string;
  sessionId?: () => string;
  clock?: Clock;
  /** Settle work the manager reports as ended (lost exit events). */
  syncWithManager?: () => Promise<unknown>;
}

function requireClient(deps: TaskToolsDeps): Promise<ManagerClient> {
  const client = deps.getClient();
  if (!client) {
    return Promise.reject(
      new Error("pbs-manager is not available in this session; task tools are disabled"),
    );
  }
  return client.ensureAvailable().then((ok) => {
    if (!ok) {
      throw new Error("pbs-manager is not available in this session; task tools are disabled");
    }
    return client;
  });
}

function agentTextFor(deps: TaskToolsDeps, id: string): string | undefined {
  const indexed = deps.getIndex?.()?.get(id);
  const isAgent = indexed?.kind === "agent" || id.startsWith("ch_");
  if (!isAgent && !deps.getRegistry?.()?.handle(id)) return undefined;
  const handle = deps.getRegistry?.()?.handle(id);
  const convo = handle?.conversation?.();
  if (convo && convo.length > 0) {
    const text = convo.map((t) => `${t.role}: ${t.text}`).join("\n");
    return indexed?.error ? `${text}\n\nError: ${indexed.error}` : text;
  }
  if (indexed?.text || indexed?.error) {
    return [indexed.text, indexed.error ? `Error: ${indexed.error}` : undefined].filter(Boolean).join("\n\n");
  }
  if (isAgent) return "";
  return undefined;
}

function formatDuration(startedAt: number, endedAt: number | null, now: number): string {
  const end = endedAt ?? now;
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTaskLine(task: TaskRecord, now: number): string {
  const exit =
    task.status === "running"
      ? `pid=${task.pid}`
      : task.exit_code !== null
        ? `exit=${task.exit_code}`
        : (task.signal ?? "done");
  const command = task.command.replace(/\s+/g, " ").trim();
  const shortCommand = command.length > 100 ? `${command.slice(0, 99)}…` : command;
  return (
    `${task.task_id} [${task.kind}] ${task.status} (${exit}, ${formatDuration(task.started_at, task.ended_at, now)})` +
    ` "${shortCommand}"` +
    `\n    output: ${task.output_path} (${task.output_size} bytes)`
  );
}

const taskListParameters = Type.Object({
  all: Type.Optional(
    Type.Boolean({ description: "Include tasks from all sessions (default: only this session)" }),
  ),
});

export function createTaskListTool(
  deps: TaskToolsDeps,
): ToolDefinition<typeof taskListParameters, { tasks: TaskRecord[]; agents: string[] }> {
  return {
    name: "task_list",
    label: "Task List",
    description:
      "List background work: pbs-manager shell/monitor tasks plus in-process subagent children. " +
      "By default only the current session is shown.",
    promptSnippet: "List background shell/monitor tasks and subagents",
    parameters: taskListParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await requireClient(deps);
      await deps.syncWithManager?.();
      const tasks = await client.list(params.all === true);
      const index = deps.getIndex?.() ?? null;
      const now = (deps.clock ?? realClock).now();
      const lines: string[] = [];
      const seen = new Set<string>();

      const pushItem = (item: WorkItem) => {
        if (seen.has(item.id)) return;
        if (!params.all && item.status !== "running" && item.status !== "pending") return;
        seen.add(item.id);
        const age = formatAge(item.startedAt, item.endedAt, now);
        lines.push(`${item.id} [${item.kind}] ${item.status} (${age}) "${item.title}"`);
      };

      if (index) {
        for (const item of index.list()) pushItem(item);
      }
      for (const task of tasks) {
        if (seen.has(task.task_id)) continue;
        if (!params.all && task.status !== "running") continue;
        // Sync-waited shells are not in the index and must not be listed as workers.
        if (task.kind === "shell" && !index?.get(task.task_id)) continue;
        seen.add(task.task_id);
        lines.push(formatTaskLine(task, now));
      }

      const agentLines: string[] = [];
      const live = deps.getRegistry?.()?.activeChildren() ?? [];
      const liveIds = new Set(live.map((c) => c.childId));
      let connected: Set<string> | undefined;
      try {
        const sessions = await client.sessions();
        connected = new Set(sessions.filter((s) => s.connected).map((s) => s.session_id));
        const own = deps.sessionId?.();
        if (own) connected.add(own);
      } catch {
        const own = deps.sessionId?.();
        connected = own ? new Set([own]) : undefined;
      }
      if (deps.home) {
        const disk = loadAgentChildRecords(deps.home, {
          sessionId: params.all === true ? undefined : deps.sessionId?.(),
          includeTerminal: params.all === true,
          ...(connected ? { connectedSessionIds: connected } : {}),
        });
        for (const rec of disk) {
          if (liveIds.has(rec.child_id) || seen.has(rec.child_id)) continue;
          if (!params.all && !isAgentStatusActive(rec.status)) continue;
          agentLines.push(
            `${rec.child_id} [agent] ${rec.status} (run=${rec.run_id}) "${formatAgentCommand(rec).replace(/^agent:/, "")}"` +
              (rec.error ? ` — error: ${rec.error}` : ""),
          );
        }
      }

      if (lines.length === 0 && agentLines.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks." }],
          details: { tasks: [], agents: [] },
        };
      }
      const header = `${lines.length + agentLines.length} background item(s):`;
      const body = [...lines];
      if (agentLines.length > 0) body.push("## other sessions", ...agentLines);
      return {
        content: [{ type: "text", text: [header, ...body].join("\n") }],
        details: { tasks, agents: agentLines },
      };
    },
  };
}

const taskOutputParameters = Type.Object({
  task_id: Type.String({ description: "Task id, e.g. sh_a1b2c3d4" }),
  cursor: Type.Optional(
    Type.Number({
      description:
        "Byte offset to read from (for incremental reads). Omit to read the tail of the output.",
    }),
  ),
  max_bytes: Type.Optional(
    Type.Number({ description: "Maximum bytes to return (default 65536)" }),
  ),
});

export interface TaskOutputDetails {
  task_id: string;
  status: string;
  exit_code: number | null;
  cursor: number;
  next_cursor: number;
  total_size: number;
}

const DEFAULT_OUTPUT_BYTES = 65536;

export function createTaskOutputTool(
  deps: TaskToolsDeps,
): ToolDefinition<typeof taskOutputParameters, TaskOutputDetails> {
  return {
    name: "task_output",
    label: "Task Output",
    description:
      "Read output of a background task. Without a cursor, returns the tail of the output " +
      "plus the current file pointer; pass the returned next_cursor as cursor for incremental reads.",
    promptSnippet: "Read background task output",
    parameters: taskOutputParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const agentText = agentTextFor(deps, params.task_id);
      if (agentText !== undefined) {
        const body = agentText || "(no output yet)";
        return {
          content: [{ type: "text", text: body }],
          details: {
            task_id: params.task_id,
            status: deps.getIndex?.()?.get(params.task_id)?.status ?? "unknown",
            exit_code: null,
            cursor: 0,
            next_cursor: 0,
            total_size: body.length,
          },
        };
      }
      const client = await requireClient(deps);
      const maxBytes =
        params.max_bytes !== undefined && params.max_bytes > 0
          ? Math.floor(params.max_bytes)
          : DEFAULT_OUTPUT_BYTES;

      let cursor = params.cursor;
      if (cursor === undefined) {
        // Tail read: probe total size, then read the last max_bytes window.
        const probe = await client.output(params.task_id, 0, 1);
        cursor = Math.max(0, probe.total_size - maxBytes);
      }

      const res = await client.output(params.task_id, cursor, maxBytes);
      const details: TaskOutputDetails = {
        task_id: params.task_id,
        status: res.status,
        exit_code: res.exit_code,
        cursor,
        next_cursor: res.next_cursor,
        total_size: res.total_size,
      };
      const body = res.chunk || "(no output yet)";
      const footer =
        `\n\n[task ${params.task_id} status=${res.status}` +
        ` exit_code=${res.exit_code === null ? "null" : res.exit_code}` +
        ` cursor=${cursor} next_cursor=${res.next_cursor} total_size=${res.total_size}]`;
      return { content: [{ type: "text", text: body + footer }], details };
    },
  };
}

const taskStopParameters = Type.Object({
  task_id: Type.String({ description: "Task id to stop, e.g. sh_a1b2c3d4" }),
});

export function createTaskStopTool(
  deps: TaskToolsDeps,
): ToolDefinition<typeof taskStopParameters, { task_id: string; stopped: boolean }> {
  return {
    name: "task_stop",
    label: "Task Stop",
    description:
      "Stop a running background task (SIGTERM to the process group, SIGKILL after a 2s grace).",
    promptSnippet: "Stop a background task",
    parameters: taskStopParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const agent = deps.getRegistry?.()?.handle(params.task_id);
      if (agent || params.task_id.startsWith("ch_") || deps.getIndex?.()?.get(params.task_id)?.kind === "agent") {
        if (!agent) {
          throw new Error(`no live subagent ${params.task_id}`);
        }
        await agent.interrupt();
        return {
          content: [{ type: "text", text: `Subagent ${params.task_id} interrupted.` }],
          details: { task_id: params.task_id, stopped: true },
        };
      }
      const client = await requireClient(deps);
      try {
        await client.stop(params.task_id, "tool");
      } finally {
        // Stopping a task that already ended emits no new exit event.
        await deps.syncWithManager?.();
      }
      return {
        content: [
          {
            type: "text",
            text: `Task ${params.task_id} stopped (SIGTERM; SIGKILL after 2s grace if needed).`,
          },
        ],
        details: { task_id: params.task_id, stopped: true },
      };
    },
  };
}
