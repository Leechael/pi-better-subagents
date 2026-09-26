/**
 * Full-screen detail panel for /tasks.
 *
 * pi's `ui.custom()` without `overlay` replaces the editor, and ScrollView only
 * clips when the chat layout engine owns it. This panel is a full-screen overlay
 * that slices its own lines, so wheel / page keys scroll and terminal selection
 * can copy the visible text.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fitLines, loadPiTui, truncateToWidth } from "./pi-tui-load";
import { realClock, type Clock, type ClockTimer } from "../clock";

export type TaskDetailTab = "output" | "stderr" | "info" | "conversation" | "result";

const TAB_ORDER: TaskDetailTab[] = ["output", "stderr", "info", "conversation", "result"];
const TAB_LABEL: Record<TaskDetailTab, string> = {
  output: "output",
  stderr: "stderr",
  info: "info",
  conversation: "conversation",
  result: "result",
};

export interface ScrollDetailOptions {
  title: string;
  /** Named panes; shortcuts 1/2/3 and Tab cycle through the provided panes. */
  tabs?: Partial<Record<TaskDetailTab, () => string>>;
  /** Single-pane content (subagent conversation). */
  content?: () => string;
  /** Poll for live updates while the task is running. */
  pollMs?: number;
  followEnd?: boolean;
  clock?: Clock;
}

/** Wrap on visible width. ANSI is preserved; CJK is not split by JS length. */
export function wrapLines(text: string, width: number): string[] {
  return fitLines(text, Math.max(1, width));
}

export function visibleDetailTabs(tabs: ScrollDetailOptions["tabs"]): TaskDetailTab[] {
  const order = tabs?.conversation ? ["conversation", "result", "info"] as const : TAB_ORDER;
  return order.filter((key) => Boolean(tabs?.[key]));
}

export function fitTitle(title: string, width: number): string {
  return truncateToWidth(title, Math.max(1, width), "…");
}

export async function showScrollDetail(ui: ExtensionUIContext, options: ScrollDetailOptions): Promise<void> {
  const piTui = loadPiTui();
  if (!piTui) throw new Error("pi-tui is not available");
  const { matchesKey } = piTui;
  await ui.custom<void>(
    (tui, theme, _kb, done) => {
      const tabKeys = () => visibleDetailTabs(options.tabs);
      let tab: TaskDetailTab = tabKeys()[0] ?? "output";
      let follow = options.followEnd !== false;
      let scroll = 0;
      let stuckToEnd = follow;
      let timer: ClockTimer | null = null;
      const clock = options.clock ?? realClock;
      let disposed = false;
      let lastLineCount = 0;

      function source(): string {
        return options.tabs?.[tab]?.() ?? options.content?.() ?? "";
      }

      function bodyHeight(width: number): { lines: string[]; height: number } {
        const rows = Math.max(8, tui.terminal?.rows ?? 24);
        const chrome = (options.tabs ? 2 : 1) + 1;
        const height = Math.max(1, rows - chrome - 1);
        return { lines: wrapLines(source(), Math.max(1, width - 2)), height };
      }

      function refresh(): void {
        if (!disposed) tui.requestRender();
      }

      if (options.pollMs && options.pollMs > 0) {
        timer = clock.setInterval(refresh, options.pollMs);
        clock.unref?.(timer);
      }

      return {
        render(width: number) {
          const { lines, height } = bodyHeight(width);
          const maxScroll = Math.max(0, lines.length - height);
          if (lines.length !== lastLineCount) {
            if (stuckToEnd) scroll = maxScroll;
            lastLineCount = lines.length;
          }
          scroll = Math.max(0, Math.min(scroll, maxScroll));
          stuckToEnd = follow && scroll >= maxScroll;

          const dim = (s: string) => theme.fg("dim", s);
          const accent = (s: string) => theme.fg("accent", s);
          const head = accent(fitTitle(options.title, Math.max(1, width - 2)));
          const keys = tabKeys();
          const tabLine = keys.length > 0
            ? `${keys.map((key, index) => tab === key ? accent(`▸ ${index + 1} ${TAB_LABEL[key]}`) : dim(`  ${index + 1} ${TAB_LABEL[key]}`)).join("    ")}  ${dim("· Tab cycle · f follow")}`
            : "";
          const visible = lines.slice(scroll, scroll + height);
          while (visible.length < height) visible.push("");
          const place =
            lines.length <= height ? "" : `  ${scroll + 1}–${Math.min(lines.length, scroll + height)}/${lines.length}`;
          const foot = dim(`↑↓ PgUp PgDn scroll · f follow ${follow ? "on" : "off"} · Esc close${place}`);
          return [head, ...(tabLine ? [tabLine] : []), ...visible, foot];
        },
        invalidate() {},
        handleInput(data: string) {
          const width = Math.max(20, tui.terminal?.columns ?? 80);
          const { lines, height } = bodyHeight(width);
          const maxScroll = Math.max(0, lines.length - height);
          const move = (next: number) => {
            scroll = Math.max(0, Math.min(maxScroll, next));
            stuckToEnd = follow && scroll >= maxScroll;
            tui.requestRender();
          };
          if (matchesKey(data, "escape") || data === "q") {
            done();
            return;
          }
          const keys = tabKeys();
          const shortcut = /^[123]$/.test(data) ? Number(data) - 1 : -1;
          if (keys.length > 0 && (matchesKey(data, "tab") || data === "\t")) {
            const current = keys.indexOf(tab);
            tab = keys[(current + 1) % keys.length];
            scroll = 0;
            stuckToEnd = follow;
            tui.requestRender();
            return;
          }
          if (shortcut >= 0 && shortcut < keys.length) {
            tab = keys[shortcut];
            scroll = 0;
            stuckToEnd = follow;
            tui.requestRender();
            return;
          }
          if (data === "f" || data === "F") {
            follow = !follow;
            if (follow) scroll = Math.max(0, bodyHeight(width).lines.length - bodyHeight(width).height);
            stuckToEnd = follow;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "up")) move(scroll - 1);
          else if (matchesKey(data, "down")) move(scroll + 1);
          else if (matchesKey(data, "pageUp")) move(scroll - Math.max(1, height - 1));
          else if (matchesKey(data, "pageDown")) move(scroll + Math.max(1, height - 1));
          else if (matchesKey(data, "home")) move(0);
          else if (matchesKey(data, "end")) move(maxScroll);
        },
        handleMouse(event: { type: string; wheelDelta?: number }) {
          if (event.type !== "wheel" || !event.wheelDelta) return undefined;
          const width = Math.max(20, tui.terminal?.columns ?? 80);
          const { lines, height } = bodyHeight(width);
          const maxScroll = Math.max(0, lines.length - height);
          scroll = Math.max(0, Math.min(maxScroll, scroll + event.wheelDelta));
          stuckToEnd = follow && scroll >= maxScroll;
          return { handled: true };
        },
        dispose() {
          disposed = true;
          if (timer !== null) clock.clearInterval(timer);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
}

/** Fallback when pi-tui cannot load (should not happen in interactive mode). */
export function notifyPlainFallback(
  notify: (message: string, type?: "info" | "warning" | "error") => void,
  title: string,
  text: string,
): void {
  notify(`${title}\n${text.slice(0, 4000)}`, "info");
}
