/**
 * Passive fleet summary below the editor — counts only, no keyboard hooks.
 *
 * Format: `2 workers · 1 subagent · 1 monitor · 4 tasks`
 *   workers   = manager shell tasks
 *   subagents = in-process subagent children
 *   monitors  = active monitors
 *   tasks     = workers + subagents + monitors (total)
 */
import type { ActiveChildInfo, RunRecord } from "./registry";

export const FLEET_WIDGET_KEY = "pbs-fleet";

const REFRESH_MS = 500;

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
}

export interface FleetStatusDeps {
  source: FleetDataSource;
  getUi: () => FleetUi | null;
  refreshMs?: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function countLabel(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function summaryLabel(workers: number, subagents: number, monitors: number, tasks: number): string {
  const parts: string[] = [];
  if (workers > 0) parts.push(countLabel(workers, "worker"));
  if (subagents > 0) parts.push(countLabel(subagents, "subagent"));
  if (monitors > 0) parts.push(countLabel(monitors, "monitor"));
  if (tasks > 0) parts.push(countLabel(tasks, "task"));
  return parts.join(" · ");
}

/**
 * Passive fleet status line (below editor). No setStatus, no keyboard capture.
 */
export class FleetWidget {
  private readonly deps: FleetStatusDeps;
  private readonly refreshMs: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private widgetRegistered = false;
  private tui: FleetTui | null = null;
  private theme: FleetTheme | null = null;
  private shells: ShellInfo[] = [];

  constructor(deps: FleetStatusDeps) {
    this.deps = deps;
    this.refreshMs = deps.refreshMs ?? REFRESH_MS;
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
    void this.pollShells().then(() => this.refresh());
  }

  refresh(): void {
    const ui = this.deps.getUi();
    if (!ui) return;

    const subagents = this.deps.source.activeChildren().length;
    const monitors = this.deps.source.listMonitors?.().length ?? 0;
    const workers = this.shells.length;
    const tasks = subagents + monitors + workers;

    if (tasks === 0) {
      this.clearWidget(ui);
      return;
    }

    if (!this.widgetRegistered) {
      ui.setWidget(
        FLEET_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          this.widgetRegistered = true;
          return {
            render: (width) => this.renderLine(width, theme),
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
    const ui = this.deps.getUi();
    if (ui) this.clearWidget(ui);
  }

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

  private renderLine(width: number, theme: FleetTheme): string[] {
    const subagents = this.deps.source.activeChildren().length;
    const monitors = this.deps.source.listMonitors?.().length ?? 0;
    const workers = this.shells.length;
    const tasks = subagents + monitors + workers;
    if (tasks === 0) return [];
    const line = summaryLabel(workers, subagents, monitors, tasks);
    return [truncate(`  ${theme.fg("muted", line)}`, Math.max(20, width))];
  }
}

/** @deprecated Use FleetWidget — kept as alias for older imports. */
export { FleetWidget as FleetStatus };
