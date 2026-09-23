/**
 * Optional TUI screenshot mode (PBS_E2E_TUI=1): a real interactive pi inside
 * tmux, driven by the faux model. After the scenario settles we capture the
 * pane and assert that no rendered line is wider than the pane.
 *
 * `capture-pane -J` joins lines the terminal soft-wrapped, so a joined line
 * longer than the pane width is exactly a line pi-tui rendered too wide.
 *
 *   PBS_E2E_TUI=1 node --test e2e/tui.test.ts
 *   PBS_E2E_TUI_KEEP=1 ...   # print captures
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FAUX_EXT, PI_BIN } from "../lib/paths.ts";
import { piArgs } from "../lib/rpc.ts";
import { createSandbox, type Sandbox, waitManagerReady } from "../lib/sandbox.ts";
import { SCRIPTS } from "./run-faux.ts";

const ENABLED = process.env.PBS_E2E_TUI === "1";
const WIDTH = 100;
const HEIGHT = 40;

/** Terminal column width of a string (no ANSI; wide CJK/emoji = 2, combining = 0). */
export function visibleWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function tmux(...args: string[]) {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const sessions: string[] = [];
const sandboxes: Sandbox[] = [];
after(() => {
  for (const s of sessions) spawnSync("tmux", ["kill-session", "-t", s]);
  for (const sb of sandboxes) sb.cleanup();
});

async function waitForPane(session: string, pred: (text: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = tmux("capture-pane", "-p", "-J", "-t", session, "-S", "-", "-E", "-");
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 300));
  }
  return text;
}

// Regressions: regular mode used to crash (pi exits on an over-wide line) from an
// unwrapped fallback pill and an untruncated monitor description (fixed by 8069e4f).
const CASES = [
  { mode: "regular", longDesc: false },
  { mode: "fullscreen", longDesc: false },
  { mode: "regular", longDesc: true },
  { mode: "fullscreen", longDesc: true },
] as const;

describe("TUI screenshot", { skip: ENABLED ? false : "set PBS_E2E_TUI=1 to run" }, () => {
  for (const c of CASES) {
    const mode = c.mode;
    const title = `${mode}${c.longDesc ? " + over-wide monitor description" : ""}: every captured line fits the ${WIDTH}-column pane`;
    it(title, async () => {
      const sb = createSandbox({ pbsConfig: { foregroundBudgetMs: 300 } });
      sandboxes.push(sb);
      const env = {
        ...sb.env,
        PBS_FAUX_SCRIPT: join(SCRIPTS, "tui-smoke.ts"),
        PBS_FAUX_TRACE: sb.tracePath,
        PBS_TUI_LONG_DESC: c.longDesc ? "1" : "0",
      };
      const argv = piArgs({ model: "faux/faux-1", extensions: [FAUX_EXT], extraArgs: ["--tui-mode", mode] }, "tui");
      const cmd = [
        "cd",
        shellQuote(sb.cwd),
        "&&",
        "env",
        ...Object.entries(env).map(([k, v]) => shellQuote(`${k}=${v}`)),
        shellQuote(PI_BIN),
        ...argv.map(shellQuote),
      ].join(" ");
      const session = `pbse-tui-${process.pid}-${mode}-${c.longDesc ? "long" : "std"}`;
      sessions.push(session);
      tmux("new-session", "-d", "-s", session, "-x", String(WIDTH), "-y", String(HEIGHT), cmd);
      tmux("set-option", "-t", session, "remain-on-exit", "on");

      await waitManagerReady(sb, 15_000);
      await new Promise((r) => setTimeout(r, 800)); // first paint
      tmux("send-keys", "-t", session, "-l", "go");
      tmux("send-keys", "-t", session, "Enter");

      // Wait for the monitor timeout wake to be handled (last surface).
      const text = await waitForPane(session, (t) => (t.match(/TUI-WOKE/g) ?? []).length >= 3, 25_000);
      const final = tmux("capture-pane", "-p", "-J", "-t", session);
      const dead = tmux("display-message", "-p", "-t", session, "#{pane_dead}").trim();
      if (process.env.PBS_E2E_TUI_KEEP) console.log(`---- ${mode} scrollback ----\n${text}\n---- visible ----\n${final}`);

      assert.equal(dead, "0", `pi exited:\n${final}`);
      assert.match(text, /TUI-WOKE/, `scenario did not complete:\n${final}`);
      const tooWide = [...text.split("\n"), ...final.split("\n")]
        .map((line, i) => ({ i, w: visibleWidth(line), line }))
        .filter((l) => l.w > WIDTH);
      assert.deepEqual(
        tooWide.map((l) => `#${l.i} width ${l.w}: ${l.line.slice(0, 120)}`),
        [],
        `lines wider than the ${WIDTH}-column pane`,
      );

      // /tasks opens as a bottom sheet over the editor, not at the top of the
      // screen far from where the user is typing (manual testing, 2026-09-24).
      if (!c.longDesc) {
        tmux("send-keys", "-t", session, "-l", "/tasks");
        tmux("send-keys", "-t", session, "Enter");
        const open = await waitForPane(session, (t) => /Enter view/.test(t), 5_000);
        const rows = tmux("capture-pane", "-p", "-J", "-t", session).split("\n");
        while (rows.length > 0 && rows.at(-1) === "") rows.pop();
        const footer = rows.findIndex((l) => l.includes("Enter view"));
        const titleRow = rows.findIndex((l) => /^\s*Tasks \d+\/\d+/.test(l));
        tmux("send-keys", "-t", session, "Escape");
        assert.ok(footer >= 0 && titleRow >= 0, `/tasks did not open:\n${open}`);
        assert.ok(titleRow > HEIGHT / 2, `/tasks title at row ${titleRow} of ${HEIGHT}; expected the lower half:\n${rows.join("\n")}`);
        assert.ok(footer >= HEIGHT - 3, `/tasks footer at row ${footer} of ${HEIGHT}; expected at the bottom:\n${rows.join("\n")}`);
      }
    });
  }
});
