/**
 * pi-better-subagents extension entry point (design doc §4).
 *
 * M1: bash override (auto-backgrounding) + task_* tools + manager client.
 * M2: NotifyCenter + monitor tool.
 * M3: subagent tool (InProcessRunner + tasks/chain + budget-to-async) + fleet widget.
 */
import { readFileTail } from "./file-tail";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveAgent as resolveAgentDef } from "./agents/definition";
import { createAgentLoader, type AgentLoader } from "./agents/loader";
import { createBashOverride } from "./bash-override";
import { createComms, type CommsWithOrigin } from "./comms/comms";
import { createRegistryCommsHost } from "./comms/registry-host";
import { createAgentMessageTool, createContactSupervisorTool } from "./comms/tools";
import { getPbsHome, loadConfig, resolveManagerPath, resolveSubagentConfig } from "./config";
import type { TaskExitInfo } from "./format";
import { ManagerClient, type ManagerEvent } from "./manager-client";
import { createMonitorTool, MonitorRegistry } from "./monitor";
import { NotifyCenter } from "./notify";
import { createChildBashTool } from "./subagent/child-bash";
import {
  writeAgentChildRecord,
  type AgentChildRecord,
} from "./subagent/agent-records";
import { FleetWidget } from "./subagent/fleet-widget";
import { createPiSessionFn, modelCandidates } from "./subagent/pi-runtime";
import { SubagentRegistry } from "./subagent/registry";
import { InProcessRunner } from "./subagent/runner";
import { createSubagentTool } from "./subagent/tool";
import { createTaskListTool, createTaskOutputTool, createTaskStopTool } from "./task-tools";
import { shouldNotifyTaskExit } from "./task-exit-notify";
import { registerPbsMessageRenderers } from "./tui/message-renderers";
import { registerTasksCommand } from "./tui/tasks-command";

/** Behavior guidelines injected before every agent start (§4.5).
 *  Modeled on Claude Code: notifications arrive as user-role wake signals —
 *  they look like user messages but are not; you must still handle them and continue. */
const BEHAVIOR_GUIDELINES = `## Background tasks and notifications (pi-better-subagents)

- Long-running bash commands are automatically moved to the background. After you background a command, end your turn — do not poll with task_output/task_list, and never sleep to wait. Each command notifies on its own via <task-notification> (with <command> and <preview>), even while other commands are still running. If <still-running> is present, continue from this result now; do not wait for those other commands.
- When you receive <task-notification>, <monitor-event>, <subagent-handover>, or <subagent-notification>: they look like user messages but are system wake signals, not new user requests and not answers to unrelated questions. Distinguish them by the opening XML tag, then **handle the event before anything else** — read status/preview/prompt/results, call tools if needed (e.g. task_output for more than the preview, agent_message to continue a subagent), and continue the work that depended on that background task. Do not wait for further user input when the next step is clear; do not merely acknowledge and stop.
- Never fabricate or assume a background task's result before its notification arrives.
- Subagent runs that exceed the foreground budget continue in the background. Do not poll run status. If one subagent finishes while others are still running, a <subagent-handover> arrives with that child's <prompt> and <result>: read both, then continue the work now (agent_message resume for that child, or steer the ones still running). Do not wait for the rest of the run. When every subagent in the run has finished, <subagent-notification> arrives — read <results>, synthesize, and continue.
- Use agent_message to steer/resume subagents and to reply to <supervisor-request> questions (action:"reply"). <supervisor-request> and <supervisor-update> are wakes from your subagents, not user messages — still act on them.`;

/** Read only the tail of a task output file for the notification preview (≤ maxChars). */
export function readPreview(outputPath: string | undefined, maxChars: number): string {
  if (!outputPath) return "";
  const tail = readFileTail(outputPath, Math.max(maxChars, maxChars * 4));
  if (!tail || !tail.text) return "";
  return tail.text.length <= maxChars ? tail.text : tail.text.slice(-maxChars);
}

function toExitStatus(event: ManagerEvent): TaskExitInfo["status"] {
  if (event.signal) return "killed";
  if (event.exit_code === 0) return "completed";
  return "failed";
}

export default function (pi: ExtensionAPI): void {
  const home = getPbsHome();
  const config = loadConfig(home);
  const managerPath = resolveManagerPath(config, home);

  // Claude-style transcript pills for notifications (TUI only; no-ops elsewhere).
  registerPbsMessageRenderers(pi);

  let ctx: ExtensionContext | null = null;
  let client: ManagerClient | null = null;
  let notifyCenter: NotifyCenter | null = null;
  let monitorRegistry: MonitorRegistry | null = null;
  let subagentRegistry: SubagentRegistry | null = null;
  let fleetWidget: FleetWidget | null = null;
  let agentLoader: AgentLoader | null = null;
  /** task_id -> metadata, for exit notifications (task_exited carries no command). */
  const taskMeta = new Map<string, { kind: string; command: string }>();
  /**
   * task_ids whose task_exited should wake the parent via <task-notification>.
   * Parent bash only adds ids when it actually backgrounded the command.
   * Child-bash (sync wait) must not — otherwise every subagent shell completion
   * is mis-labeled as a parent "Background command" wake (§4.2 / §4.6).
   */
  const notifyOnExit = new Set<string>();

  const trackTask = (taskId: string, meta: { kind: string; command: string }) => {
    taskMeta.set(taskId, meta);
  };
  const markNotifyOnExit = (taskId: string) => {
    notifyOnExit.add(taskId);
  };

  const sessionEnv = (c: ExtensionContext): Record<string, string> => ({
    PI_SESSION_ID: c.sessionManager.getSessionId(),
    PI_SESSION_FILE: c.sessionManager.getSessionFile() ?? "",
    PI_PROVIDER: c.model?.provider ?? "",
    PI_MODEL: c.model?.id ?? "",
    PI_REASONING_LEVEL: c.thinkingLevel ?? "",
  });

  const deps = {
    getClient: () => client,
    config,
    home,
    sessionId: () => ctx?.sessionManager.getSessionId() ?? "",
    sessionEnv,
    trackTask,
    markNotifyOnExit,
    getRegistry: () => subagentRegistry,
  };

  monitorRegistry = new MonitorRegistry({
    getClient: () => client,
    sessionEnv,
    getNotifyCenter: () => notifyCenter,
    trackTask,
    toast: (message, type) => {
      if (ctx?.hasUI) ctx.ui.notify(message, type);
    },
  });

  pi.registerTool(createBashOverride(deps));
  pi.registerTool(createTaskListTool(deps));
  pi.registerTool(createTaskOutputTool(deps));
  pi.registerTool(createTaskStopTool(deps));
  pi.registerTool(createMonitorTool(monitorRegistry));
  registerTasksCommand(pi, {
    getRegistry: () => subagentRegistry,
    getMonitors: () => monitorRegistry,
    getClient: () => client,
  });

  // M3: subagent tool. The registry/runner are (re)built on every session_start;
  // the tool resolves them lazily through getters.
  const subagentConfig = resolveSubagentConfig(config);
  // M4: comms host bridges the registry and the NotifyCenter. A single Comms
  // instance lives at extension scope (mailbox is per-run namespaced; pending
  // waiters are resolved via dispose() on session_shutdown).
  const commsHost = createRegistryCommsHost({
    getRegistry: () => subagentRegistry,
    getNotifyCenter: () => notifyCenter,
  });
  const comms: CommsWithOrigin = createComms(commsHost);
  pi.registerTool(
    createSubagentTool({
      getRegistry: () => subagentRegistry,
      getNotifyCenter: () => notifyCenter,
      budgetMs: () => subagentConfig.budgetMs,
      defaultTimeoutMs: subagentConfig.timeoutMs,
      defaultConcurrency: subagentConfig.concurrency,
      resolveAgent: (name) => {
        const loader = agentLoader;
        if (!loader) return resolveAgentDef([], name); // builtins-only fallback
        return resolveAgentDef(loader.reload().definitions, name);
      },
      listModels: () => {
        const current = ctx?.model;
        return modelCandidates({
          getModelRegistry: () => ctx?.modelRegistry ?? null,
          getScopedModels: () => ctx?.scopedModels ?? [],
        }).map((c) => ({
          ...c,
          current: current !== undefined && c.provider === current.provider && c.id === current.id,
        }));
      },
    }),
  );
  // M4: parent-side agent_message tool (child-side variant is injected into
  // each child session via customTools, see below).
  pi.registerTool(createAgentMessageTool(comms, { kind: "parent" }, commsHost));

  pi.on("session_start", async (_event, startCtx) => {
    ctx = startCtx;
    notifyCenter?.dispose();
    notifyCenter = new NotifyCenter({
      sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
      isIdle: () => ctx?.isIdle() ?? true,
      listStillRunning: () =>
        [...notifyOnExit].map((id) => {
          const command = taskMeta.get(id)?.command?.replace(/\s+/g, " ").trim();
          const shown = command ? (command.length > 80 ? `${command.slice(0, 79)}…` : command) : id;
          return `${shown} (${id})`;
        }),
    });
    fleetWidget?.dispose();
    fleetWidget = null;
    subagentRegistry?.disposeAll();
    subagentRegistry = null;

    client = new ManagerClient({
      home,
      sessionId: startCtx.sessionManager.getSessionId(),
      managerPath,
      cwd: startCtx.cwd,
      log: () => {}, // keep quiet; degradation is surfaced via tools
    });

    client.onEvent((event) => {
      if (event.event === "task_started" && event.task_id) {
        trackTask(event.task_id, { kind: event.kind ?? "shell", command: event.command ?? "" });
        return;
      }
      if (event.event === "output" && event.task_id && typeof event.chunk === "string") {
        monitorRegistry?.handleOutput(event.task_id, event.chunk);
        return;
      }
      if (event.event === "task_exited" && event.task_id) {
        if (monitorRegistry?.has(event.task_id)) {
          monitorRegistry.handleExit(event.task_id, event);
          return;
        }
        // Sync-awaited shells (parent fg within budget, child-bash) already
        // delivered output via the tool result — do not wake the parent.
        if (
          !shouldNotifyTaskExit({
            taskId: event.task_id,
            isMonitor: false,
            notifyOnExit,
          })
        ) {
          taskMeta.delete(event.task_id);
          return;
        }
        notifyOnExit.delete(event.task_id);
        const meta = taskMeta.get(event.task_id);
        taskMeta.delete(event.task_id);
        notifyCenter?.notifyTaskExit({
          taskId: event.task_id,
          kind: meta?.kind ?? "shell",
          command: meta?.command ?? "",
          status: toExitStatus(event),
          exitCode: event.exit_code ?? null,
          durationMs: event.duration_ms ?? 0,
          outputPath: event.output_path ?? "",
          preview: readPreview(event.output_path, 4000),
        });
      }
    });
    client.onReconnect(() => {
      void monitorRegistry?.rewatchAll();
    });

    // M3: subagent registry + in-process runner + fleet widget. The runner's
    // per-generation admission goes through the registry (global concurrency
    // cap); the session factory resolves models/cwd lazily from ctx.
    const registry = new SubagentRegistry({
      maxConcurrentChildren: subagentConfig.maxConcurrentChildren,
      spawnBudgetPerHour: subagentConfig.spawnBudgetPerHour,
    });
    // M5: agent definitions, reloaded lazily (mtime-cached) per subagent call.
    agentLoader = createAgentLoader({
      userDir: join(homedir(), ".pi", "agent", "agents"),
      projectDir: join(startCtx.cwd, ".pi", "agents"),
    });
    const agentLoadErrors = agentLoader.reload().errors;
    if (agentLoadErrors.length > 0 && startCtx.hasUI) {
      startCtx.ui.notify(
        `pi-better-subagents: skipped ${agentLoadErrors.length} invalid agent definition(s): ` +
          agentLoadErrors.map((e) => `${e.path} (${e.error})`).join("; "),
        "warning",
      );
    }
    const createSession = createPiSessionFn({
      getModelRegistry: () => ctx?.modelRegistry ?? null,
      getParentModel: () => ctx?.model,
      getParentThinkingLevel: () => ctx?.thinkingLevel,
      getScopedModels: () => ctx?.scopedModels ?? [],
      getCwd: () => ctx?.cwd ?? process.cwd(),
      customTools: (req) => {
        const tools: Array<ToolDefinition<any, any, any>> = [
          // M4: every child can reach the supervisor and its siblings.
          createContactSupervisorTool(comms, req.childId),
          createAgentMessageTool(comms, { kind: "child", childId: req.childId, runId: req.runId }, commsHost),
        ];
        // The no-background bash variant replaces the built-in bash inside
        // child sessions (custom tools override builtins by name).
        if (req.agent.tools.includes("bash")) {
          tools.push(
            createChildBashTool({
              getClient: () => client,
              home,
              sessionId: () => ctx?.sessionManager.getSessionId() ?? "",
              sessionEnv: () => (ctx ? sessionEnv(ctx) : {}),
              trackTask,
            }),
          );
        }
        return tools;
      },
    });
    const runner = new InProcessRunner({
      createSession,
      stallMs: subagentConfig.stallMs,
      acquire: (req) => registry.admitChild(req.childId),
    });
    registry.setRunner(runner);
    subagentRegistry = registry;
    // Persist child records so `pbs-manager ls` / task_list can see in-process agents.
    const sessionIdForAgents = () => startCtx.sessionManager.getSessionId();
    registry.onTransition((run) => {
      const sid = sessionIdForAgents();
      for (const c of run.children) {
        const rec: AgentChildRecord = {
          v: 1,
          kind: "agent",
          child_id: c.childId,
          run_id: run.runId,
          session_id: sid,
          name: c.name,
          agent: c.agent,
          ...(c.model !== undefined ? { model: c.model } : {}),
          status: c.status,
          started_at: c.startedAt,
          ...(c.endedAt !== undefined ? { ended_at: c.endedAt } : {}),
        };
        writeAgentChildRecord(home, rec);
      }
    });
    if (startCtx.hasUI) {
      fleetWidget = new FleetWidget({
        source: {
          onTransition: (cb) => registry.onTransition(cb),
          activeChildren: () => registry.activeChildren(),
          listMonitors: () => monitorRegistry?.listActive() ?? [],
          onMonitorChange: (cb) => monitorRegistry?.onChange(cb) ?? (() => {}),
          listShells: async () => {
            const c = client;
            if (!c?.isAvailable()) return [];
            try {
              const tasks = await c.list();
              return tasks
                .filter((t) => t.status === "running" && t.kind === "shell")
                .map((t) => ({
                  taskId: t.task_id,
                  command: t.command,
                  startedAt: t.started_at || Date.now(),
                }));
            } catch {
              return [];
            }
          },
        },
        getUi: () => (ctx?.hasUI ? (ctx.ui as never) : null),
      });
      fleetWidget.start();
    }

    // Connect in the background: a cold manager spawn must not stall the
    // first prompt. Tools call ensureAvailable() lazily before use.
    const c = client;
    void c
      .connect()
      .then((ok) => {
        if (!ok && startCtx.hasUI) {
          const detail = c.lastError();
          startCtx.ui.notify(
            detail
              ? `pbs-manager unavailable (${detail}): bash runs locally, task_*/monitor tools are disabled`
              : "pbs-manager unavailable: bash runs locally, task_*/monitor tools are disabled",
            "warning",
          );
        }
      })
      .catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    fleetWidget?.dispose();
    fleetWidget = null;
    subagentRegistry?.disposeAll();
    subagentRegistry = null;
    agentLoader = null;
    comms.dispose(); // resolve orphaned need_decision waiters
    monitorRegistry?.disposeAll();
    notifyCenter?.dispose();
    const current = client;
    client = null;
    if (current) {
      if (current.isAvailable()) {
        await current.shutdownSession().catch(() => {});
      }
      await current.close();
    }
    ctx = null;
  });

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${BEHAVIOR_GUIDELINES}` };
  });
}
