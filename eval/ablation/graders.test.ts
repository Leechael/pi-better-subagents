/**
 * Anti-placebo check for the real-model graders: run the real episode
 * pipeline (sandbox, pi, pbs-manager, ablation harness) with scripted faux
 * behaviors and assert each grader passes the good behavior and fails the
 * bad one for the intended reason. No model cost.
 *
 *   node --test ablation/graders.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FAUX_EXT } from "../lib/paths.ts";
import { runEpisode } from "./episode.ts";
import { loadManifest, resolveVariant } from "./manifest.ts";
import { getScenario } from "./scenarios.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "faux-behaviors.ts");
const baseline = resolveVariant(loadManifest(), "baseline");

async function episode(scenarioId: string, behavior: string) {
  const r = await runEpisode({
    model: "faux/faux-1",
    variant: baseline,
    scenario: getScenario(scenarioId),
    extensions: [FAUX_EXT],
    env: { PBS_FAUX_SCRIPT: FIXTURE, PBS_FAUX_BEHAVIOR: `${scenarioId}/${behavior}` },
  });
  return r;
}

const CASES: Array<[string, string, boolean, RegExp]> = [
  ["bg-end-turn", "good", true, /ended turn/],
  ["bg-end-turn", "poll", false, /polled 1x/],
  ["no-fabrication", "good", true, /waited for the real key/],
  ["no-fabrication", "fabricate", false, /fabricated before wake/],
  ["monitor-not-sleep", "good", true, /monitor \+ correct token/],
  ["monitor-not-sleep", "sleep-loop", false, /sleep\/poll loop/],
  ["monitor-not-sleep", "tail-grep", true, /event-driven-bash \+ correct token/],
  ["resume-finished", "resume", true, /resumed via subagent-resume$/],
  ["resume-finished", "send-then-resume", true, /resumed via subagent-resume-after-agent_message/],
  ["resume-finished", "send-only", false, /resumed via agent_message-send-only/],
  ["supervisor-reply", "reply", true, /replied; child applied it/],
  ["supervisor-reply", "send", false, /answered via agent_message:send/],
];

describe("graders on scripted behaviors", { concurrency: true }, () => {
  for (const [scenario, behavior, pass, reason] of CASES) {
    it(`${scenario}/${behavior} → ${pass ? "PASS" : "FAIL"}`, async () => {
      const r = await episode(scenario, behavior);
      assert.equal(r.error, undefined, `episode error: ${r.error}`);
      assert.equal(r.grade.pass, pass, `${r.grade.reason} ${JSON.stringify(r.grade.metrics)}`);
      assert.match(r.grade.reason, reason, JSON.stringify(r.grade.metrics));
    });
  }
});
