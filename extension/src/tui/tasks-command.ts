/**
 * /tasks — list running subagents, monitors, and shell workers.
 *
 * View opens a full-screen scrollable panel (mouse wheel + terminal selection).
 * Subagents show their conversation. Monitors and shells have output / stderr tabs.
 * A finished subagent stays listed only while its detail view is open.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerClient, TaskRecord } from "../manager-client";
import type { MonitorRegistry } from "../monitor";
import { formatConversation } from "../subagent/conversation";
import type { RunRecord, SubagentRegistry } from "../subagent/registry";
import { readTaskFileTail, stderrPathFor } from "./task-output-paths";
import { isSubagentPinned, pinSubagent, unpinSubagent } from "./tasks-pin";
import { notifyPlainFallback, showScrollDetail } from "./scroll-detail-view";

export interface TasksCommandDeps {
  getRegistry: () => SubagentRegistry | null;
  getMonitors: () => MonitorRegistry | null;
  getClient: () => ManagerClient | null;
}

export function registerTasksCommand(pi: ExtensionAPI, deps: TasksCommandDeps): void {
  pi.registerCommand("tasks", {
    description: "List running subagents, monitors, and shell tasks",
    handler: async (_args, ctx) => {
      await openTasksUi(ctx, deps);
    },
  });
  pi.registerCommand("bashes", {
    description: "Alias for /tasks",
    handler: async (_args, ctx) => {
      await openTasksUi(ctx, deps);
    },
  });
}

interface TaskOption {
  key: string;
  label: string;
  stop: () => Promise<void>;
  view: (ctx: ExtensionContext) => Promise<void>;
}

/** Running children, plus finished ones whose detail view is still open. */
export function visibleSubagentChildren(runs: readonly RunRecord[]): RunRecord["children"] {
  const children: RunRecord["children"] = [];
  for (const run of runs) {
    for (const child of run.children) {
      const active = child.status === "pending" || child.status === "running";
      if (active || isSubagentPinned(child.childId)) children.push(child);
    }
  }
  return children;
}

async function openTasksUi(ctx: ExtensionContext, deps: TasksCommandDeps): Promise<void> {
  const options = await collectOptions(deps);
  if (!ctx.hasUI) {
    ctx.ui.notify(
      options.length ? options.map((o) => o.label).join("\n") : "No background tasks.",
      "info",
    );
    return;
  }
  if (options.length === 0) {
    ctx.ui.notify("No background tasks.", "info");
    return;
  }

  const labels = [...options.map((o) => o.label), "↻ Refresh", "Close"];
  const picked = await ctx.ui.select("Background tasks", labels);
  if (!picked || picked === "Close") return;
  if (picked === "↻ Refresh") {
    await openTasksUi(ctx, deps);
    return;
  }
  const item = options.find((o) => o.label === picked);
  if (!item) return;

  const action = await ctx.ui.select(picked, ["View", "Stop / interrupt", "Back"]);
  if (action === "View") {
    await item.view(ctx);
    await openTasksUi(ctx, deps);
    return;
  }
  if (action !== "Stop / interrupt") {
    await openTasksUi(ctx, deps);
    return;
  }
  try {
    await item.stop();
    ctx.ui.notify(`Stopped ${item.key}`, "info");
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

async function collectOptions(deps: TasksCommandDeps): Promise<TaskOption[]> {
  const options: TaskOption[] = [];
  const registry = deps.getRegistry();
  const client = deps.getClient();
  const tasks = await listManagerTasks(client);

  for (const child of visibleSubagentChildren(registry?.list() ?? [])) {
    options.push({
      key: child.childId,
      label: `subagent · ${child.name} (${child.agent}) · ${child.status} · ${child.childId}`,
      stop: async () => {
        await registry?.handle(child.childId)?.interrupt();
      },
      view: (ctx) => viewSubagent(ctx, registry, child.childId, child.name),
    });
  }

  for (const mon of deps.getMonitors()?.listActive() ?? []) {
    const record = tasks.find((t) => t.task_id === mon.taskId);
    options.push({
      key: mon.taskId,
      label: `monitor · ${mon.description} · ${mon.taskId}`,
      stop: async () => {
        await client?.ensureAvailable();
        await client?.stop(mon.taskId);
      },
      view: (ctx) => viewTaskLogs(ctx, `monitor ${mon.description}`, record?.output_path ?? ""),
    });
  }

  for (const t of tasks.filter((x) => x.status === "running" && x.kind === "shell")) {
    const command = (t.command.split("\n")[0] ?? "").slice(0, 60);
    options.push({
      key: t.task_id,
      label: `worker · ${command} · ${t.task_id}`,
      stop: async () => {
        await client?.ensureAvailable();
        await client?.stop(t.task_id);
      },
      view: (ctx) => viewTaskLogs(ctx, `worker ${t.task_id}`, t.output_path),
    });
  }
  return options;
}

async function listManagerTasks(client: ManagerClient | null): Promise<TaskRecord[]> {
  if (!client?.isAvailable()) return [];
  try {
    return await client.list();
  } catch {
    return [];
  }
}

async function viewSubagent(
  ctx: ExtensionContext,
  registry: SubagentRegistry | null,
  childId: string,
  name: string,
): Promise<void> {
  pinSubagent(childId);
  try {
    const read = () => formatConversation(registry?.handle(childId)?.conversation() ?? []);
    if (!ctx.hasUI) return;
    try {
      await showScrollDetail(ctx.ui, {
        title: `subagent ${name}`,
        content: read,
        pollMs: 500,
      });
    } catch {
      notifyPlainFallback(ctx.ui.notify.bind(ctx.ui), `subagent ${name}`, read());
    }
  } finally {
    unpinSubagent(childId);
  }
}

async function viewTaskLogs(ctx: ExtensionContext, title: string, outputPath: string): Promise<void> {
  if (!ctx.hasUI) return;
  const stderrPath = stderrPathFor(outputPath);
  const read = () => ({
    output: readTaskFileTail(outputPath),
    stderr: readTaskFileTail(stderrPath),
  });
  try {
    await showScrollDetail(ctx.ui, {
      title,
      tabs: {
        output: () => read().output,
        stderr: () => read().stderr,
      },
      pollMs: 500,
    });
  } catch {
    notifyPlainFallback(ctx.ui.notify.bind(ctx.ui), title, read().output);
  }
}
