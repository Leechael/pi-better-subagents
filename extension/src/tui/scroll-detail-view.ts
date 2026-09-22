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

export type TaskLogTab = "output" | "stderr";

export interface ScrollDetailOptions {
  title: string;
  /** When set, Tab / 1 / 2 switch between merged output and stderr-only file. */
  tabs?: { output: () => string; stderr: () => string };
  /** Single-pane content (subagent conversation). */
  content?: () => string;
  /** Poll for live updates while the task is running. */
  pollMs?: number;
  followEnd?: boolean;
}

/** Wrap on visible width. ANSI is preserved; CJK is not split by JS length. */
export function wrapLines(text: string, width: number): string[] {
  return fitLines(text, Math.max(1, width));
}

export function fitTitle(title: string, width: number): string {
  return truncateToWidth(title, Math.max(1, width), "…");
}

export async function showScrollDetail(ui: ExtensionUIContext, options: ScrollDetailOptions): Promise<void> {
  const piTui = loadPiTui();
  if (!piTui) throw new Error("pi-tui is not available");
  const { matchesKey } = piTui;
  const follow = options.followEnd !== false;

  await ui.custom<void>(
    (tui, theme, _kb, done) => {
      let tab: TaskLogTab = "output";
      let scroll = 0;
      let stuckToEnd = follow;
      let timer: NodeJS.Timeout | null = null;
      let disposed = false;
      let lastLineCount = 0;

      function source(): string {
        if (options.tabs) return tab === "stderr" ? options.tabs.stderr() : options.tabs.output();
        return options.content?.() ?? "";
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
        timer = setInterval(refresh, options.pollMs);
        timer.unref?.();
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
          const tabLine = options.tabs
            ? `${tab === "output" ? accent("▸ output") : dim("  output")}    ${
                tab === "stderr" ? accent("▸ stderr") : dim("  stderr")
              }  ${dim("· Tab or 1/2")}`
            : "";
          const visible = lines.slice(scroll, scroll + height);
          while (visible.length < height) visible.push("");
          const place =
            lines.length <= height ? "" : `  ${scroll + 1}–${Math.min(lines.length, scroll + height)}/${lines.length}`;
          const foot = dim(`↑↓ PgUp PgDn scroll · select to copy · Esc close${place}`);
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
          if (options.tabs && (matchesKey(data, "tab") || data === "2")) {
            tab = tab === "output" ? "stderr" : "output";
            scroll = 0;
            stuckToEnd = follow;
            tui.requestRender();
            return;
          }
          if (options.tabs && data === "1") {
            tab = "output";
            scroll = 0;
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
          if (timer) clearInterval(timer);
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        row: 0,
        col: 0,
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
