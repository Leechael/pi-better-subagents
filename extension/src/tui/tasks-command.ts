/**
 * /tasks — one live overlay for shells, monitors, and subagents.
 *
 * ↑↓ select, Enter views, s stops, Esc backs out of a detail or closes the list.
 * Finished items stay viewable while they remain in the work index.
 */
import { DynamicBorder, keyHint, rawKeyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realClock, type Clock } from "../clock";
import type { ManagerClient } from "../manager-client";
import { formatConversation } from "../subagent/conversation";
import type { SubagentRegistry } from "../subagent/registry";
import { formatAge, type WorkIndex, type WorkItem } from "../work-index";
import { notifyPlainFallback, showScrollDetail } from "./scroll-detail-view";
import { readTaskFileTailCached, stderrPathFor } from "./task-output-paths";
import { loadPiTui, truncateToWidth } from "./pi-tui-load";

const AGE_TICK_MS = 1000;

function isLive(item: WorkItem): boolean {
  return item.status === "pending" || item.status === "running";
}

/** Selection follows the item id so a reorder (active first) cannot move the cursor. */
export function selectedIndex(items: readonly WorkItem[], selectedId: string | undefined): number {
  if (items.length === 0) return 0;
  if (!selectedId) return 0;
  const i = items.findIndex((item) => item.id === selectedId);
  return i >= 0 ? i : 0;
}

export function moveSelection(
  items: readonly WorkItem[],
  selectedId: string | undefined,
  dir: -1 | 1,
): string | undefined {
  if (items.length === 0) return undefined;
  const i = selectedIndex(items, selectedId);
  const next = Math.max(0, Math.min(items.length - 1, i + dir));
  return items[next]?.id;
}

export function stopChoice(
  items: readonly WorkItem[],
  selectedId: string | undefined,
): { action: "stop" | "already-finished" | "none"; id?: string } {
  if (items.length === 0) return { action: "none" };
  const item = items[selectedIndex(items, selectedId)];
  if (!item) return { action: "none" };
  if (!isLive(item)) return { action: "already-finished", id: item.id };
  return { action: "stop", id: item.id };
}

export interface TasksCommandDeps {
  getRegistry: () => SubagentRegistry | null;
  getIndex: () => WorkIndex | null;
  getClient: () => ManagerClient | null;
  clock?: Clock;
}

export function registerTasksCommand(pi: ExtensionAPI, deps: TasksCommandDeps): void {
  pi.registerCommand("tasks", {
    description: "List background shells, monitors, and subagents",
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

export function formatWorkRows(
  items: readonly WorkItem[],
  selectedId: string | undefined,
  now: number,
  width: number,
): string[] {
  if (items.length === 0) {
    return [truncateToWidth("No background tasks.", Math.max(1, width), "")];
  }
  const selected = selectedIndex(items, selectedId);
  return items.map((item, i) => {
    const mark = i === selected ? "▸" : " ";
    const age = formatAge(item.startedAt, item.endedAt, now);
    const raw = `${mark} ${item.kind.padEnd(7)} ${item.status.padEnd(11)} ${age.padEnd(6)} ${item.title}`;
    return truncateToWidth(raw, Math.max(1, width), "…");
  });
}

function selectorHint(theme: { fg(color: string, text: string): string }): string {
  try {
    return [
      keyHint("tui.select.up", ""),
      keyHint("tui.select.down", ""),
      keyHint("tui.select.confirm", "view"),
      rawKeyHint("s", "stop"),
      keyHint("tui.select.cancel", "close"),
    ].join("  ");
  } catch {
    // keyHint reads the pi theme singleton (globalThis). Unit tests and a
    // jiti cache that has not called initTheme() throw; the running TUI has it.
    return theme.fg("dim", "↑↓ select · Enter view · s stop · Esc close");
  }
}

export interface TaskListChoice {
  action: "close" | "view" | "stop" | "already-finished";
  id?: string;
}

async function openTasksUi(ctx: ExtensionContext, deps: TasksCommandDeps): Promise<void> {
  const index = deps.getIndex();
  const clock = deps.clock ?? realClock;
  const items = () => index?.list(clock.now()) ?? [];
  if (!ctx.hasUI) {
    const list = items();
    ctx.ui.notify(
      list.length
        ? formatWorkRows(list, undefined, clock.now(), 100).join("\n")
        : "No background tasks.",
      "info",
    );
    return;
  }
  if (!index) {
    ctx.ui.notify("No background tasks.", "info");
    return;
  }

  let selectedId: string | undefined;
  for (;;) {
    const choice = await showTaskList(ctx, () => index.list(clock.now()), (cb) => index.onChange(cb), selectedId, clock);
    if (!choice || choice.action === "close") return;
    selectedId = choice.id ?? selectedId;
    if (!choice.id) continue;
    const item = index.get(choice.id);
    if (!item) continue;
    if (choice.action === "already-finished") {
      ctx.ui.notify(`${item.id} already finished`, "info");
      continue;
    }
    if (choice.action === "stop") {
      try {
        await stopItem(item, deps);
        ctx.ui.notify(`Stopped ${item.id}`, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
      continue;
    }
    await viewItem(ctx, item, deps);
  }
}

async function showTaskList(
  ctx: ExtensionContext,
  getItems: () => WorkItem[],
  subscribe: (cb: () => void) => () => void,
  initialSelectedId: string | undefined,
  clock: Clock,
): Promise<TaskListChoice | undefined> {
  const piTui = loadPiTui();
  if (!piTui) {
    const items = getItems();
    notifyPlainFallback(
      ctx.ui.notify.bind(ctx.ui),
      "Background tasks",
      items.length ? formatWorkRows(items, initialSelectedId, clock.now(), 100).join("\n") : "No background tasks.",
    );
    return { action: "close" };
  }
  const { matchesKey } = piTui;

  return ctx.ui.custom<TaskListChoice | undefined>(
    (tui, theme, kb, done) => {
      let selectedId = initialSelectedId;
      const unsub = subscribe(() => tui.requestRender());
      const ageTimer = clock.setInterval(() => tui.requestRender(), AGE_TICK_MS);
      clock.unref?.(ageTimer);
      const border = new DynamicBorder((text) => theme.fg("border", text));
      const matches = (
        data: string,
        id: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
      ) => {
        try {
          return kb.matches(data, id);
        } catch {
          return false;
        }
      };
      return {
        render(width: number) {
          const items = getItems();
          selectedId = items[selectedIndex(items, selectedId)]?.id;
          const inner = Math.max(1, width);
          const title = truncateToWidth(theme.fg("accent", "Background tasks"), inner, "…");
          const hint = truncateToWidth(selectorHint(theme), inner, "…");
          const rows = formatWorkRows(items, selectedId, clock.now(), inner);
          return [...border.render(inner), title, hint, ...rows, ...border.render(inner)];
        },
        invalidate() {
          border.invalidate();
        },
        handleInput(data: string) {
          const items = getItems();
          if (matches(data, "tui.select.cancel") || matchesKey(data, "escape") || data === "q") {
            done({ action: "close", id: selectedId });
            return;
          }
          if (matches(data, "tui.select.up") || matchesKey(data, "up")) {
            selectedId = moveSelection(items, selectedId, -1);
            tui.requestRender();
            return;
          }
          if (matches(data, "tui.select.down") || matchesKey(data, "down")) {
            selectedId = moveSelection(items, selectedId, 1);
            tui.requestRender();
            return;
          }
          if (matches(data, "tui.select.confirm") || matchesKey(data, "enter") || data === "\r") {
            const item = items[selectedIndex(items, selectedId)];
            if (!item) return;
            done({ action: "view", id: item.id });
            return;
          }
          if (data === "s") {
            const choice = stopChoice(items, selectedId);
            if (choice.action === "none" || !choice.id) return;
            done({ action: choice.action, id: choice.id });
          }
        },
        dispose() {
          clock.clearInterval(ageTimer);
          unsub();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    },
  );
}

async function stopItem(item: WorkItem, deps: TasksCommandDeps): Promise<void> {
  if (item.kind === "agent") {
    const handle = deps.getRegistry()?.handle(item.id);
    if (!handle) throw new Error(`no live subagent ${item.id}`);
    await handle.interrupt();
    return;
  }
  const client = deps.getClient();
  if (!client) throw new Error("pbs-manager is not available");
  await client.ensureAvailable();
  await client.stop(item.id);
}

async function viewItem(ctx: ExtensionContext, item: WorkItem, deps: TasksCommandDeps): Promise<void> {
  if (!ctx.hasUI) return;
  if (item.kind === "agent") {
    const read = () =>
      formatConversation(deps.getRegistry()?.handle(item.id)?.conversation() ?? []) ||
      item.text ||
      "(no output)";
    try {
      await showScrollDetail(ctx.ui, { title: `subagent ${item.title}`, content: read, pollMs: 500, clock: deps.clock });
    } catch {
      notifyPlainFallback(ctx.ui.notify.bind(ctx.ui), item.title, read());
    }
    return;
  }
  const outputPath = item.outputPath ?? "";
  const stderrPath = item.stderrPath || stderrPathFor(outputPath);
  try {
    await showScrollDetail(ctx.ui, {
      title: `${item.kind} ${item.title}`,
      tabs: {
        output: () => readTaskFileTailCached(outputPath),
        stderr: () => readTaskFileTailCached(stderrPath),
      },
      pollMs: 500,
      clock: deps.clock,
    });
  } catch {
    notifyPlainFallback(ctx.ui.notify.bind(ctx.ui), item.title, readTaskFileTailCached(outputPath));
  }
}
