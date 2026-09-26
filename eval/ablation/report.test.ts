import assert from "node:assert/strict";
import { it } from "node:test";
import { buildReport } from "./report.ts";
import type { ResultRecord } from "./run.ts";

const rec = (variant: string, scenario: string, pass: boolean): ResultRecord => ({
  v: 1,
  ts: "",
  model: "m/x",
  variant,
  scenario,
  attempt: 0,
  pass,
  reason: "",
  metrics: {},
  durationMs: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 },
  ablationMisses: [],
});
const many = (variant: string, scenario: string, passes: number, n: number) =>
  Array.from({ length: n }, (_, i) => rec(variant, scenario, i < passes));

it("flags a 20pp drop as load-bearing, a flat segment as slop, and alarms on a load-bearing control", () => {
  const report = buildReport([
    ...many("baseline", "bg-end-turn", 9, 10),
    ...many("guidelines.end-turn-after-bg", "bg-end-turn", 5, 10), // -40pp
    ...many("rules.bash-no-poll", "bg-end-turn", 9, 10), // 0pp
    ...many("rules.pi-env", "bg-end-turn", 6, 10), // control, -30pp
  ]);
  const verdicts = report.slice(report.indexOf("## Segment verdicts")).split("\n");
  const verdict = (id: string) => verdicts.find((l) => l.startsWith(`| ${id}`)) ?? "";
  assert.match(verdict("guidelines.end-turn-after-bg"), /\| load-bearing \| -40pp/);
  assert.match(verdict("rules.bash-no-poll"), /\| slop \|/);
  assert.match(verdict("rules.pi-env"), /control came out load-bearing/);
  assert.match(verdict("wake.lead-in"), /\| untested \|/);
  assert.match(report, /50% \(5\/10\) \[24–76\] Δ-40pp \*\*▼\*\*/);
});
