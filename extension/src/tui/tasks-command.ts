/**
 * /tasks slash command — Claude Code `/tasks` analogue.
 * Lists running agents, monitors, and shell tasks; offers stop actions.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagerClient } from "../manager-client";
import type { MonitorRegistry } from "../monitor";
import type { SubagentRegistry } from "../subagent/registry";

export interface TasksCommandDeps {
  getRegistry: () => SubagentRegistry | null;
  getMonitors: () => MonitorRegistry | null;
  getClient: () => ManagerClient | null;
}

export function registerTasksCommand(pi: ExtensionAPI, deps: TasksCommandDeps): void {
  pi.registerCommand("tasks", {
    description: "List and manage background agents, monitors, and shell tasks",
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
  key: string; // encoded into the select label
  label: string;
  stop: () => Promise<void>;
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

  const action = await ctx.ui.select(`Manage: ${picked}`, ["Stop / interrupt", "Back"]);
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
  for (const child of registry?.activeChildren() ?? []) {
    options.push({
      key: child.childId,
      label: `agent · ${child.name} (${child.agent}) · ${child.status}`,
      stop: async () => {
        await registry?.handle(child.childId)?.interrupt();
      },
    });
  }
  for (const mon of deps.getMonitors()?.listActive() ?? []) {
    options.push({
      key: mon.taskId,
      label: `monitor · ${mon.description} · ${mon.taskId}`,
      stop: async () => {
        const client = deps.getClient();
        await client?.ensureAvailable();
        await client?.stop(mon.taskId);
      },
    });
  }
  const client = deps.getClient();
  if (client?.isAvailable()) {
    try {
      const tasks = await client.list();
      for (const t of tasks.filter((x) => x.status === "running" && x.kind === "shell")) {
        options.push({
          key: t.task_id,
          label: `shell · ${(t.command.split("\n")[0] ?? "").slice(0, 60)} · ${t.task_id}`,
          stop: async () => {
            await client.ensureAvailable();
            await client.stop(t.task_id);
          },
        });
      }
    } catch {
      // ignore
    }
  }
  return options;
}
