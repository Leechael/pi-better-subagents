/**
 * pi-better-subagents extension entry point (design doc §4).
 *
 * M1: bash override (auto-backgrounding) + task_* tools + manager client.
 * M2: NotifyCenter + monitor tool.
 * M3: subagent tool (InProcessRunner + tasks/chain + budget-to-async) + fleet widget.
 */
import { applyBehaviorGuidelines } from "./behavior-guidelines";
import { realClock } from "./clock";
import { ExitNotifyGate } from "./exit-notify-gate";
import { createExtensionEventLog } from "./events";
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
import { registerReplyCommand } from "./comms/reply-command";
import { getPbsHome, loadConfig, resolveManagerPath, resolveSubagentConfig } from "./config";
import type { TaskExitInfo } from "./format";
import { ManagerClient, type ManagerEvent } from "./manager-client";
import { createMonitorTool, MonitorRegistry } from "./monitor";
import { NotifyCenter } from "./notify";
import { createChildBashTool } from "./subagent/child-bash";
import {
  agentEndReason,
  headOf,
  tailOf,
  writeAgentChildRecord,
  type AgentChildRecord,
} from "./subagent/agent-records";
import { TranscriptWriter } from "./subagent/transcript";
import { FleetWidget } from "./subagent/fleet-widget";
import { WorkIndex, type WorkItem } from "./work-index";
import { createPiSessionFn, modelCandidates } from "./subagent/pi-runtime";
import { SubagentRegistry } from "./subagent/registry";
import { InProcessRunner } from "./subagent/runner";
import { createSubagentTool } from "./subagent/tool";
import { createTaskListTool, createTaskOutputTool, createTaskStopTool } from "./task-tools";
import { registerPbsMessageRenderers } from "./tui/message-renderers";
import { registerTasksCommand } from "./tui/tasks-command";
import { stderrPathFor } from "./tui/task-output-paths";
import { shellWakeTitle } from "./wake";

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
  const clock = realClock;

  // Claude-style transcript pills for notifications (TUI only; no-ops elsewhere).
  registerPbsMessageRenderers(pi);

  let ctx: ExtensionContext | null = null;
  let client: ManagerClient | null = null;
  let notifyCenter: NotifyCenter | null = null;
  let monitorRegistry: MonitorRegistry | null = null;
  let subagentRegistry: SubagentRegistry | null = null;
  let fleetWidget: FleetWidget | null = null;
  let agentLoader: AgentLoader | null = null;
  /** task_id -> metadata, for notifications and the original manager task start time. */
  const taskMeta = new Map<string, { kind: string; command: string; cwd?: string; startedAt?: number }>();
  /**
   * task_ids whose task_exited should wake the parent via <pbs-wake kind="task">.
   * Parent bash only adds ids when it actually backgrounded the command.
   * Child-bash (sync wait) must not — otherwise every subagent shell completion
   * is mis-labeled as a parent "Background command" wake (§4.2 / §4.6).
   */
  const notifyOnExit = new Set<string>();
  const exitGate = new ExitNotifyGate<ManagerEvent>({ clock });
  const workIndex = new WorkIndex({ clock });
  const eventLog = createExtensionEventLog(home, () => ctx?.sessionManager.getSessionId() ?? "", clock);
  const logEvent = (type: string, fields?: Record<string, unknown>) => eventLog.write(type, fields);

  const trackTask = (taskId: string, meta: { kind: string; command: string; cwd?: string }) => {
    taskMeta.set(taskId, { ...meta, startedAt: taskMeta.get(taskId)?.startedAt });
  };
  const upsertBackgroundTask = (taskId: string, startedAt: number) => {
    const meta = taskMeta.get(taskId);
    workIndex.upsert({
      id: taskId,
      kind: "shell",
      status: "running",
      title: meta?.command?.replace(/\s+/g, " ").trim() || taskId,
      command: meta?.command,
      cwd: meta?.cwd,
      startedAt,
      countsAsWorker: true,
    });
  };
  const deliverExit = (taskId: string, event: ManagerEvent) => {
    notifyOnExit.delete(taskId);
    const meta = taskMeta.get(taskId);
    taskMeta.delete(taskId);
    workIndex.patch(taskId, {
      status: toExitStatus(event),
      endedAt: clock.now(),
      exitCode: event.exit_code ?? null,
      ...(event.signal ? { signal: event.signal } : {}),
      ...(event.end_reason ? { endReason: event.end_reason } : {}),
      ...(event.output_path
            ? { outputPath: event.output_path, stderrPath: stderrPathFor(event.output_path) }
            : {}),
    });
    notifyCenter?.notifyTaskExit({
      taskId,
      kind: meta?.kind ?? event.kind ?? "shell",
      command: meta?.command ?? event.command ?? "",
      status: toExitStatus(event),
      exitCode: event.exit_code ?? null,
      ...(typeof event.signal === "string" && event.signal ? { signal: event.signal } : {}),
      durationMs: event.duration_ms ?? 0,
      outputPath: event.output_path ?? "",
      preview: readPreview(event.output_path, 4000),
    });
  };

  const markNotifyOnExit = (taskId: string) => {
    notifyOnExit.add(taskId);
    void client?.markBackground(taskId).catch(() => {});
    const prior = exitGate.mark(taskId);
    if (prior) {
      deliverExit(taskId, prior);
      return;
    }
    const startedAt = taskMeta.get(taskId)?.startedAt;
    if (startedAt !== undefined) {
      upsertBackgroundTask(taskId, startedAt);
    } else {
      // If task_started was missed (e.g. reconnect), recover the daemon's start
      // time rather than making this task appear younger than it is.
      void client?.list(true).then((tasks) => {
        const task = tasks.find((candidate) => candidate.task_id === taskId);
        const recoveredStart = taskMeta.get(taskId)?.startedAt ?? task?.started_at;
        if (recoveredStart !== undefined && notifyOnExit.has(taskId)) {
          const current = taskMeta.get(taskId) ?? { kind: "shell", command: task?.command ?? "" };
          taskMeta.set(taskId, { ...current, startedAt: recoveredStart });
          upsertBackgroundTask(taskId, recoveredStart);
        }
      }).catch(() => {});
    }
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
    clock,
    getRegistry: () => subagentRegistry,
    getIndex: () => workIndex,
  };

  monitorRegistry = new MonitorRegistry({
    getClient: () => client,
    sessionEnv,
    getNotifyCenter: () => notifyCenter,
    trackTask,
    clock,
    logEvent,
    toast: (message, type) => {
      if (ctx?.hasUI) ctx.ui.notify(message, type);
    },
  });

  pi.registerTool(createBashOverride(deps));
  pi.registerTool(createTaskListTool({ ...deps, getIndex: () => workIndex }));
  pi.registerTool(createTaskOutputTool({ ...deps, getIndex: () => workIndex }));
  pi.registerTool(createTaskStopTool({ ...deps, getIndex: () => workIndex }));
  pi.registerTool(createMonitorTool(monitorRegistry));
  registerTasksCommand(pi, {
    getRegistry: () => subagentRegistry,
    getIndex: () => workIndex,
    getClient: () => client,
    home,
    sessionId: () => ctx?.sessionManager.getSessionId() ?? "",
    clock,
  });
  monitorRegistry.onChange(() => {
    for (const mon of monitorRegistry.listActive()) {
      const existing = workIndex.get(mon.taskId);
      workIndex.upsert({
        id: mon.taskId,
        kind: "monitor",
        status: "running",
        title: mon.description,
        command: taskMeta.get(mon.taskId)?.command,
        cwd: taskMeta.get(mon.taskId)?.cwd,
        startedAt: existing?.startedAt ?? mon.startedAt,
        outputPath: existing?.outputPath,
        stderrPath: existing?.stderrPath,
        countsAsWorker: false,
      });
    }
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
  const comms: CommsWithOrigin = createComms(commsHost, {
    decisionTimeoutMs: subagentConfig.decisionTimeoutMs,
    clock,
    logEvent,
  });
  registerReplyCommand(pi, comms);
  pi.registerTool(
    createSubagentTool({
      getRegistry: () => subagentRegistry,
      getNotifyCenter: () => notifyCenter,
      budgetMs: () => subagentConfig.budgetMs,
      defaultTimeoutMs: subagentConfig.timeoutMs,
      defaultConcurrency: subagentConfig.concurrency,
      clock,
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
  pi.registerTool(createAgentMessageTool(comms, { kind: "parent" }, commsHost, clock));

  pi.on("session_start", async (_event, startCtx) => {
    ctx = startCtx;
    const base = (
      startCtx as { getSystemPromptOptions?: () => { sections?: Record<string, string> } }
    ).getSystemPromptOptions?.();
    if (base) applyBehaviorGuidelines(base);
    notifyCenter?.dispose();
    notifyCenter = new NotifyCenter({
      sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
      isIdle: () => ctx?.isIdle() ?? true,
      clock,
      logEvent,
      listStillRunning: () =>
        [...notifyOnExit].map((id) => {
          const command = taskMeta.get(id)?.command;
          const title = command ? shellWakeTitle(command) || id : id;
          return { id, title };
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
      clock,
      log: () => {}, // keep quiet; degradation is surfaced via tools
    });

    client.onEvent((event) => {
      if (event.event === "task_started" && event.task_id) {
        const prior = taskMeta.get(event.task_id);
        taskMeta.set(event.task_id, {
          kind: prior?.kind ?? event.kind ?? "shell",
          command: prior?.command ?? event.command ?? "",
          ...(typeof event.ts === "number"
            ? { startedAt: event.ts }
            : prior?.startedAt !== undefined
              ? { startedAt: prior.startedAt }
              : {}),
        });
        if (notifyOnExit.has(event.task_id) && typeof event.ts === "number") {
          upsertBackgroundTask(event.task_id, event.ts);
        }
        if (event.kind === "monitor" && !workIndex.get(event.task_id)) {
          workIndex.upsert({
            id: event.task_id,
            kind: "monitor",
            status: "running",
            title: event.command || event.task_id,
            command: event.command,
            cwd: taskMeta.get(event.task_id)?.cwd,
            startedAt: clock.now(),
            countsAsWorker: false,
          });
        }
        return;
      }
      if (event.event === "output" && event.task_id && typeof event.chunk === "string") {
        monitorRegistry?.handleOutput(event.task_id, event.chunk);
        return;
      }
      if (event.event === "task_exited" && event.task_id) {
        if (monitorRegistry?.has(event.task_id)) {
          monitorRegistry.handleExit(event.task_id, event);
          workIndex.patch(event.task_id, {
            status: toExitStatus(event),
            endedAt: clock.now(),
            exitCode: event.exit_code ?? null,
            ...(event.signal ? { signal: event.signal } : {}),
            ...(event.end_reason ? { endReason: event.end_reason } : {}),
            ...(event.output_path
            ? { outputPath: event.output_path, stderrPath: stderrPathFor(event.output_path) }
            : {}),
          });
          return;
        }
        workIndex.patch(event.task_id, {
          status: toExitStatus(event),
          endedAt: clock.now(),
          exitCode: event.exit_code ?? null,
          ...(event.signal ? { signal: event.signal } : {}),
          ...(event.end_reason ? { endReason: event.end_reason } : {}),
          ...(event.output_path
            ? { outputPath: event.output_path, stderrPath: stderrPathFor(event.output_path) }
            : {}),
        });
        // Exit may share a socket read with wait done:false, before bash marks
        // the id. Stash and fire on the late mark. Sync waits never mark.
        if (exitGate.onExit(event.task_id, event, false) !== "notify") return;
        deliverExit(event.task_id, event);
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
      clock,
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
      getModelRuntime: () => {
        const registry = ctx?.modelRegistry as { runtime?: unknown } | null | undefined;
        return registry?.runtime;
      },
      getParentModel: () => ctx?.model,
      getParentThinkingLevel: () => ctx?.thinkingLevel,
      getScopedModels: () => ctx?.scopedModels ?? [],
      getCwd: () => ctx?.cwd ?? process.cwd(),
      customTools: (req) => {
        const tools: Array<ToolDefinition<any, any, any>> = [
          // M4: every child can reach the supervisor and its siblings.
          createContactSupervisorTool(comms, req.childId),
          createAgentMessageTool(comms, { kind: "child", childId: req.childId, runId: req.runId }, commsHost, clock),
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
              childId: req.childId,
              runId: req.runId,
              clock,
            }),
          );
        }
        return tools;
      },
    });
    const transcripts = new TranscriptWriter(home, clock);
    const syncTranscript = (childId: string): string | undefined => {
      const handle = registry.handle(childId);
      if (!handle) return undefined;
      return transcripts.sync(startCtx.sessionManager.getSessionId(), childId, handle.conversation());
    };
    const runner = new InProcessRunner({
      createSession,
      clock,
      stallMs: subagentConfig.stallMs,
      acquire: (req) => registry.admitChild(req.childId),
      onActivity: (childId) => {
        syncTranscript(childId);
      },
    });
    registry.setRunner(runner);
    subagentRegistry = registry;
    // Persist child records so `pbs-manager ls` / task_list can see in-process agents.
    const sessionIdForAgents = () => startCtx.sessionManager.getSessionId();
    const previousAgentStatus = new Map<string, string>();
    registry.onTransition((run) => {
      const sid = sessionIdForAgents();
      for (const c of run.children) {
        const previousStatus = previousAgentStatus.get(c.childId);
        if (c.status === "running" && previousStatus !== "running") {
          logEvent("agent.start", {
            child_id: c.childId,
            run_id: run.runId,
            name: c.name,
            agent: c.agent,
            ...(c.model ? { model: c.model } : {}),
          });
        }
        if (["completed", "failed", "interrupted"].includes(c.status) && previousStatus !== c.status) {
          const error = c.result?.error;
          if (error === "stalled") logEvent("agent.stall", { child_id: c.childId });
          if (error === "timeout") logEvent("agent.timeout", { child_id: c.childId });
          logEvent("agent.settle", {
            child_id: c.childId,
            status: c.status,
            ...(error ? { error } : {}),
            duration_ms: c.result?.durationMs ?? Math.max(0, clock.now() - c.startedAt),
          });
        }
        previousAgentStatus.set(c.childId, c.status);
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
          ...(c.result?.error ? { error: c.result.error } : {}),
          ...(c.prompt !== undefined ? { prompt_head: headOf(c.prompt) } : {}),
          ...(c.result?.text ? { result_tail: tailOf(c.result.text) } : {}),
        };
        const endReason = agentEndReason(c.status, c.result);
        if (endReason) rec.end_reason = endReason;
        const transcript = syncTranscript(c.childId);
        if (transcript) {
          rec.transcript = transcript;
          rec.tool_calls = transcripts.toolCallCount(c.childId);
        }
        writeAgentChildRecord(home, rec);
        workIndex.upsert({
          id: c.childId,
          kind: "agent",
          status: c.status,
          title: `${c.name} (${c.agent})${c.model ? ` ${c.model}` : ""}`,
          startedAt: c.startedAt,
          ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
          countsAsWorker: false,
          runId: run.runId,
          name: c.name,
          agent: c.agent,
          ...(c.model !== undefined ? { model: c.model } : {}),
          cwd: startCtx.cwd,
          ...(c.prompt !== undefined ? { prompt: c.prompt } : {}),
          ...(c.preamble !== undefined ? { preamble: c.preamble } : {}),
          ...(c.result?.text ? { text: c.result.text } : {}),
          ...(c.result?.error ? { error: c.result.error } : {}),
        });
      }
    });
    if (startCtx.hasUI) {
      fleetWidget = new FleetWidget({
        index: workIndex,
        getUi: () => (ctx?.hasUI ? (ctx.ui as never) : null),
        clock,
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

  pi.on("agent_settled", async () => {
    notifyCenter?.flushMonitorEvents();
  });

  pi.on("before_agent_start", async (event) => {
    applyBehaviorGuidelines(event.systemPromptOptions as { sections?: Record<string, string> });
  });
}
