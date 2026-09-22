/**
 * Passive fleet summary below the editor — counts only, no keyboard hooks.
 *
 * Format: `2 workers · 1 subagent · 1 monitor`
 *   workers   = backgrounded shell tasks (not sync-waited)
 *   subagents = in-process subagent children
 *   monitors  = active monitors
 *
 * Driven by WorkIndex changes. Does not poll the manager.
 */
import type { WorkIndex } from "../work-index";
import { truncateToWidth } from "../tui/pi-tui-load";

export const FLEET_WIDGET_KEY = "pbs-fleet";

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

export interface FleetStatusDeps {
  index: WorkIndex;
  getUi: () => FleetUi | null;
}

function countLabel(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function summaryLabel(workers: number, subagents: number, monitors: number): string {
  const parts: string[] = [];
  if (workers > 0) parts.push(countLabel(workers, "worker"));
  if (subagents > 0) parts.push(countLabel(subagents, "subagent"));
  if (monitors > 0) parts.push(countLabel(monitors, "monitor"));
  return parts.join(" · ");
}

/**
 * Passive fleet status line (below editor). No setStatus, no keyboard capture, no poll.
 */
export class FleetWidget {
  private readonly deps: FleetStatusDeps;
  private started = false;
  private widgetRegistered = false;
  private tui: FleetTui | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: FleetStatusDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.index.onChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const ui = this.deps.getUi();
    if (!ui) return;
    const counts = this.deps.index.counts();
    const total = counts.workers + counts.subagents + counts.monitors;
    if (total === 0) {
      this.clearWidget(ui);
      return;
    }
    if (!this.widgetRegistered) {
      ui.setWidget(
        FLEET_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          this.widgetRegistered = true;
          return {
            render: (width) => this.renderLine(width, theme),
            invalidate: () => {},
            dispose: () => {
              if (this.tui === tui) {
                this.tui = null;
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
    this.unsubscribe?.();
    this.unsubscribe = null;
    const ui = this.deps.getUi();
    if (ui) this.clearWidget(ui);
  }

  private clearWidget(ui: FleetUi): void {
    if (this.widgetRegistered || this.tui) {
      ui.setWidget(FLEET_WIDGET_KEY, undefined, { placement: "belowEditor" });
      this.widgetRegistered = false;
      this.tui = null;
    }
  }

  private renderLine(width: number, theme: FleetTheme): string[] {
    const counts = this.deps.index.counts();
    const line = summaryLabel(counts.workers, counts.subagents, counts.monitors);
    if (!line) return [];
    const painted = `  ${theme.fg("muted", line)}`;
    return [truncateToWidth(painted, Math.max(20, width), "…")];
  }
}

/** @deprecated Use FleetWidget — kept as alias for older imports. */
export { FleetWidget as FleetStatus };
