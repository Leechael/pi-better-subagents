/**
 * Fleet status surface — Claude Code–inspired TUI for monitors + subagents.
 *
 * Collapsed (default): one muted summary line below the editor
 *   `2 agents · 1 monitor · ↓ to manage`
 * plus a footer status slot (`setStatus`) with the same counts.
 *
 * Expanded (↓/← with empty editor): selectable roster with tree connectors,
 * elapsed clocks, Enter → inspector (select + stop), Esc → collapse.
 *
 * Uses a Component factory + `tui.requestRender()` (not string[] rebuilds) so
 * the wall-clock spinner animates every ~500ms without hitting the 10-line
 * string-widget hard cap.
 */
import type { ActiveChildInfo, RunRecord } from "./registry";

export const FLEET_WIDGET_KEY = "pbs-fleet";
export const FLEET_STATUS_KEY = "pbs-fleet";

const REFRESH_MS = 500;
const MAX_ROWS = 8;

export interface FleetTheme {
  fg(color: string, text: string): string;
}

export interface FleetTui {
  requestRender(): void;
}

export interface FleetWidgetComponent {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

export interface FleetUi {
  setWidget(
    key: string,
    content:
      | string[]
      | undefined
      | ((tui: FleetTui, theme: FleetTheme) => FleetWidgetComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setStatus?(key: string, text: string | undefined): void;
  onTerminalInput?(
    handler: (data: string) => { consume?: boolean } | undefined,
  ): () => void;
  getEditorText?(): string;
  select?(title: string, options: string[]): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface MonitorInfo {
  taskId: string;
  description: string;
  startedAt: number;
}

export interface ShellInfo {
  taskId: string;
  command: string;
  startedAt: number;
}

export interface FleetDataSource {
  onTransition(cb: (run: RunRecord) => void): void;
  activeChildren(): ActiveChildInfo[];
  listMonitors?(): MonitorInfo[];
  onMonitorChange?(cb: () => void): () => void;
  listShells?(): Promise<ShellInfo[]> | ShellInfo[];
  stopTask?(taskId: string): Promise<void>;
  interruptChild?(childId: string): Promise<void>;
}

export interface FleetStatusDeps {
  source: FleetDataSource;
  getUi: () => FleetUi | null;
  refreshMs?: number;
  now?: () => number;
}

type RosterItem =
  | { kind: "agent"; child: ActiveChildInfo; last: boolean }
  | { kind: "monitor"; mon: MonitorInfo; last: boolean }
  | { kind: "shell"; shell: ShellInfo; last: boolean };

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function matchesKey(data: string, name: "down" | "up" | "left" | "enter" | "escape" | "j" | "k"): boolean {
  // Common terminal sequences + raw chars. Enough for fleet navigation without
  // a hard dependency on @earendil-works/pi-tui Key helpers.
  if (name === "down") return data === "\x1b[B" || data === "\x1bOB" || data === "j";
  if (name === "up") return data === "\x1b[A" || data === "\x1bOA" || data === "k";
  if (name === "left") return data === "\x1b[D" || data === "\x1bOD";
  if (name === "enter") return data === "\r" || data === "\n";
  if (name === "escape") return data === "\x1b" || data === "\x1b\x1b";
  if (name === "j") return data === "j";
  if (name === "k") return data === "k";
  return false;
}

/**
 * Claude-style fleet status widget.
 * Kept under the historical export name `FleetWidget` so existing imports work.
 */
export class FleetWidget {
  private readonly deps: FleetStatusDeps;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private inputUnsub: (() => void) | null = null;
  private started = false;
  private widgetRegistered = false;
  private tui: FleetTui | null = null;
  private theme: FleetTheme | null = null;
  private expanded = false;
  private selected = 0;
  private inspectorOpen = false;
  private shells: ShellInfo[] = [];
  private lastStatus = "";

  constructor(deps: FleetStatusDeps) {
    this.deps = deps;
    this.refreshMs = deps.refreshMs ?? REFRESH_MS;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.source.onTransition(() => this.refresh());
    this.deps.source.onMonitorChange?.(() => this.refresh());
    this.timer = setInterval(() => {
      void this.pollShells().then(() => this.refresh());
    }, this.refreshMs);
    this.timer.unref?.();
    const ui = this.deps.getUi();
    if (ui?.onTerminalInput) {
      this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
    }
    void this.pollShells().then(() => this.refresh());
  }

  refresh(): void {
    const ui = this.deps.getUi();
    if (!ui) return;
    const agents = this.deps.source.activeChildren();
    const monitors = this.deps.source.listMonitors?.() ?? [];
    const shells = this.shells;
    const total = agents.length + monitors.length + shells.length;

    // Footer status slot (always visible even when widget collapsed/cleared).
    const status = this.summaryLabel(agents.length, monitors.length, shells.length);
    if (ui.setStatus && status !== this.lastStatus) {
      this.lastStatus = status;
      ui.setStatus(FLEET_STATUS_KEY, total > 0 ? status : undefined);
    }

    if (total === 0) {
      this.expanded = false;
      this.selected = 0;
      this.clearWidget(ui);
      return;
    }

    if (!this.widgetRegistered) {
      // Component factory: register once, then requestRender on ticks.
      ui.setWidget(
        FLEET_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          this.widgetRegistered = true;
          return {
            render: (width) => this.render(width, theme),
            invalidate: () => {},
            dispose: () => {
              if (this.tui === tui) {
                this.tui = null;
                this.theme = null;
                this.widgetRegistered = false;
              }
            },
          };
        },
        { placement: "belowEditor" },
      );
      return;
    }
    this.tui?.requestRender();
  }

  dispose(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.inputUnsub?.();
    this.inputUnsub = null;
    const ui = this.deps.getUi();
    if (ui) {
      this.clearWidget(ui);
      ui.setStatus?.(FLEET_STATUS_KEY, undefined);
    }
    this.lastStatus = "";
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async pollShells(): Promise<void> {
    try {
      const list = await this.deps.source.listShells?.();
      this.shells = list ?? [];
    } catch {
      this.shells = [];
    }
  }

  private clearWidget(ui: FleetUi): void {
    if (this.widgetRegistered || this.tui) {
      ui.setWidget(FLEET_WIDGET_KEY, undefined, { placement: "belowEditor" });
      this.widgetRegistered = false;
      this.tui = null;
      this.theme = null;
    }
  }

  private summaryLabel(agents: number, monitors: number, shells: number): string {
    const parts: string[] = [];
    if (agents > 0) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
    if (monitors > 0) parts.push(`${monitors} monitor${monitors === 1 ? "" : "s"}`);
    if (shells > 0) parts.push(`${shells} shell${shells === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  private roster(): RosterItem[] {
    const agents = this.deps.source.activeChildren();
    const monitors = this.deps.source.listMonitors?.() ?? [];
    const shells = this.shells;
    const items: RosterItem[] = [];
    agents.forEach((child, i) => {
      items.push({
        kind: "agent",
        child,
        last: i === agents.length - 1 && monitors.length === 0 && shells.length === 0,
      });
    });
    monitors.forEach((mon, i) => {
      items.push({
        kind: "monitor",
        mon,
        last: i === monitors.length - 1 && shells.length === 0,
      });
    });
    shells.forEach((shell, i) => {
      items.push({ kind: "shell", shell, last: i === shells.length - 1 });
    });
    // Fix last flags across groups
    for (let i = 0; i < items.length; i++) items[i].last = i === items.length - 1;
    return items;
  }

  private render(width: number, theme: FleetTheme): string[] {
    if (this.inspectorOpen) return [];
    const agents = this.deps.source.activeChildren();
    const monitors = this.deps.source.listMonitors?.() ?? [];
    const shells = this.shells;
    const total = agents.length + monitors.length + shells.length;
    if (total === 0) return [];

    if (!this.expanded) {
      const label = this.summaryLabel(agents.length, monitors.length, shells.length);
      return [
        truncate(
          `  ${theme.fg("muted", label)} · ${theme.fg("dim", "↓ to manage")}`,
          Math.max(20, width),
        ),
      ];
    }

    const lines: string[] = [
      truncate(`  ${theme.fg("dim", "↑↓/jk select · enter inspect · esc back")}`, Math.max(20, width)),
    ];
    const roster = this.roster();
    const start = Math.max(0, Math.min(this.selected, roster.length - 1) - (MAX_ROWS - 1));
    const end = Math.min(roster.length, start + MAX_ROWS);
    if (start > 0) lines.push(`  ${theme.fg("dim", `↑ ${start} more`)}`);
    for (let i = start; i < end; i++) {
      lines.push(this.renderRow(roster[i], i === this.selected, width, theme));
    }
    if (end < roster.length) lines.push(`  ${theme.fg("dim", `↓ ${roster.length - end} more`)}`);
    return lines;
  }

  private renderRow(item: RosterItem, selected: boolean, width: number, theme: FleetTheme): string {
    const bullet = selected ? theme.fg("accent", "❯") : theme.fg("dim", "•");
    const branch = item.last ? "└─" : "├─";
    const now = this.now();
    let body: string;
    if (item.kind === "agent") {
      const elapsed = formatElapsed(now - item.child.startedAt);
      const name = theme.fg("toolTitle", item.child.name);
      const agent = theme.fg("muted", `(${item.child.agent})`);
      const model = item.child.model
        ? ` · ${theme.fg("dim", item.child.model)}`
        : "";
      body = `${name} ${agent}${model} · ${item.child.status} · ${theme.fg("dim", elapsed)}`;
    } else if (item.kind === "monitor") {
      const elapsed = formatElapsed(now - item.mon.startedAt);
      const desc = theme.fg("accent", truncate(item.mon.description, 40));
      body = `monitor ${desc} · ${theme.fg("dim", item.mon.taskId)} · ${theme.fg("dim", elapsed)}`;
    } else {
      const elapsed = formatElapsed(now - item.shell.startedAt);
      const cmd = theme.fg("bashMode", truncate(item.shell.command.split("\n")[0] ?? "", 40));
      body = `shell ${cmd} · ${theme.fg("dim", elapsed)}`;
    }
    return truncate(`  ${branch} ${bullet} ${body}`, Math.max(20, width));
  }

  private handleKey(data: string): { consume?: boolean } | undefined {
    const ui = this.deps.getUi();
    if (!ui || this.inspectorOpen) return undefined;
    const roster = this.roster();
    if (roster.length === 0) return undefined;

    const editorEmpty = !ui.getEditorText || ui.getEditorText() === "";
    if (!this.expanded) {
      if ((matchesKey(data, "down") || matchesKey(data, "left")) && editorEmpty) {
        this.expanded = true;
        this.selected = 0;
        this.refresh();
        return { consume: true };
      }
      return undefined;
    }

    // Expanded: only consume nav keys when editor is empty (same as pi-subagents).
    if (!editorEmpty) {
      this.expanded = false;
      this.refresh();
      return undefined;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "left")) {
      this.expanded = false;
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = Math.min(roster.length - 1, this.selected + 1);
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.selected === 0) {
        this.expanded = false;
        this.refresh();
        return { consume: true };
      }
      this.selected = Math.max(0, this.selected - 1);
      this.refresh();
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      const item = roster[this.selected];
      if (item) void this.openInspector(item);
      return { consume: true };
    }
    return undefined;
  }

  private async openInspector(item: RosterItem): Promise<void> {
    const ui = this.deps.getUi();
    if (!ui?.select) {
      ui?.notify?.("Inspector requires TUI select()", "warning");
      return;
    }
    this.inspectorOpen = true;
    this.refresh();
    try {
      const title =
        item.kind === "agent"
          ? `Agent ${item.child.name}`
          : item.kind === "monitor"
            ? `Monitor ${item.mon.description}`
            : `Shell ${item.shell.taskId}`;
      const action = await ui.select(title, [
        "status — Show details",
        "stop — Stop / interrupt",
        "back",
      ]);
      if (action?.startsWith("status")) {
        const detail =
          item.kind === "agent"
            ? `${item.child.name} (${item.child.agent}) · ${item.child.model ?? "model?"} · ${item.child.status} · ${item.child.childId}`
            : item.kind === "monitor"
              ? `${item.mon.description} · ${item.mon.taskId}`
              : `${item.shell.taskId} · ${item.shell.command.split("\n")[0]}`;
        ui.notify?.(detail, "info");
      } else if (action?.startsWith("stop")) {
        const ok = ui.confirm
          ? await ui.confirm("Stop task?", "This sends an interrupt/stop signal.")
          : true;
        if (ok) {
          try {
            if (item.kind === "agent") await this.deps.source.interruptChild?.(item.child.childId);
            else if (item.kind === "monitor") await this.deps.source.stopTask?.(item.mon.taskId);
            else await this.deps.source.stopTask?.(item.shell.taskId);
            ui.notify?.("Stopped.", "info");
          } catch (err) {
            ui.notify?.(err instanceof Error ? err.message : String(err), "error");
          }
        }
      }
    } finally {
      this.inspectorOpen = false;
      this.refresh();
    }
  }
}

/** @deprecated Use FleetWidget — kept as alias for older imports. */
export { FleetWidget as FleetStatus };
