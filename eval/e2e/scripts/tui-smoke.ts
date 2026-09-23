/**
 * TUI screenshot scenario: produce every custom surface (backgrounded bash
 * row, task wake pill, monitor row + event pills, fleet line) with
 * deliberately long, wide-character text to stress line widths.
 */
import { call, type FauxScript, say } from "../faux-dsl.ts";

const LONG = "x".repeat(160);
const WIDE = "宽字符测试".repeat(12);
/** PBS_TUI_LONG_DESC=1: a monitor description wider than the pane (crash repro). */
const description = process.env.PBS_TUI_LONG_DESC === "1" ? `watch ${WIDE} ${LONG}` : "watch 宽字符 lines";

const script: FauxScript = {
  steps: [
    call("bash", { command: `echo ${WIDE}; sleep 1.2; echo tui-canary ${LONG}` }),
    call("monitor", {
      command: `for i in 1 2; do echo "${WIDE} line-$i ${LONG}"; sleep 0.3; done; sleep 30`,
      description,
      timeout_ms: 2500,
    }),
    say(`Armed. ${WIDE} ${LONG}`),
  ],
  fallback: say(`TUI-WOKE ${WIDE}`),
};
export default script;
