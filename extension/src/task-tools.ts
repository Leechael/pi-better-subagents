/**
 * task_* tools (design doc §4.3): inspect and stop manager tasks.
 */
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ManagerClient, TaskRecord } from "./manager-client";

export interface TaskToolsDeps {
  getClient: () => ManagerClient | null;
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

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTaskLine(task: TaskRecord): string {
  const exit =
    task.status === "running"
      ? `pid=${task.pid}`
      : task.exit_code !== null
        ? `exit=${task.exit_code}`
        : (task.signal ?? "done");
  const command = task.command.replace(/\s+/g, " ").trim();
  const shortCommand = command.length > 100 ? `${command.slice(0, 99)}…` : command;
  return (
    `${task.task_id} [${task.kind}] ${task.status} (${exit}, ${formatDuration(task.started_at, task.ended_at)})` +
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
): ToolDefinition<typeof taskListParameters, { tasks: TaskRecord[] }> {
  return {
    name: "task_list",
    label: "Task List",
    description:
      "List background tasks (shell commands and monitors) managed by pbs-manager. " +
      "By default only tasks of the current session are shown.",
    promptSnippet: "List background shell/monitor tasks",
    parameters: taskListParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const client = await requireClient(deps);
      const tasks = await client.list(params.all === true);
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks." }], details: { tasks: [] } };
      }
      const running = tasks.filter((t) => t.status === "running").length;
      const header = `${tasks.length} task(s), ${running} running:`;
      const text = [header, ...tasks.map(formatTaskLine)].join("\n");
      return { content: [{ type: "text", text }], details: { tasks } };
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
      const client = await requireClient(deps);
      await client.stop(params.task_id);
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
