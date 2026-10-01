/**
 * Anti-placebo check for the real-model graders: run the real episode
 * pipeline (sandbox, pi, pi-famulus, ablation harness) with scripted faux
 * behaviors and assert each grader passes the good behavior and fails the
 * bad one for the intended reason. No model cost.
 *
 *   node --test ablation/graders.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FAUX_EXT } from "../lib/paths.ts";
import { itemsFromEvents, toolResults, wakes } from "../lib/transcript.ts";
import { runEpisode } from "./episode.ts";
import { loadManifest, resolveVariant } from "./manifest.ts";
import { getScenario, type Scenario } from "./scenarios.ts";
import { TAIL_GREP_COMMAND } from "./fixtures/tail-grep-command.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "faux-behaviors.ts");
const baseline = resolveVariant(loadManifest(), "baseline");

async function episode(scenarioId: string, behavior: string, diagnostics: string, scenario = getScenario(scenarioId), script = FIXTURE) {
  const r = await runEpisode({
    model: "faux/faux-1",
    variant: baseline,
    scenario,
    transcriptDir: join(diagnostics, "h"),
    label: "events",
    extensions: [FAUX_EXT],
    env: {
      PI_FAMULUS_FAUX_SCRIPT: script,
      PI_FAMULUS_FAUX_BEHAVIOR: `${scenarioId}/${behavior}`,
      PI_FAMULUS_FAUX_TRACE: join(diagnostics, "faux-trace.jsonl"),
    },
  });
  writeFileSync(join(diagnostics, "h", "config.json"), JSON.stringify({
    scenario: scenarioId, behavior, scenarioTimeoutMs: scenario.timeoutMs,
    famulusConfig: scenario.famulusConfig, durationMs: r.durationMs, usage: r.usage,
    grade: r.grade, error: r.error,
  }, null, 2));
  return r;
}

/** These paths match CI's existing sandbox artifact globs; keep only failures. */
async function withDiagnostics(check: (directory: string) => Promise<void>) {
  const directory = mkdtempSync("/tmp/eval-grade-");
  try {
    await check(directory);
  } catch (error) {
    console.error(`grader failure diagnostics: ${directory} (RPC events + faux request contexts)`);
    throw error;
  }
  rmSync(directory, { recursive: true, force: true });
}

const CASES: Array<[string, string, boolean, RegExp]> = [
  ["bg-end-turn", "good", true, /ended turn/],
  ["bg-end-turn", "poll", false, /polled 1x/],
  ["no-fabrication", "good", true, /waited for the real key/],
  ["no-fabrication", "fabricate", false, /fabricated before wake/],
  ["no-fabrication", "describe-format", true, /waited for the real key/],
  ["monitor-not-sleep", "good", true, /monitor \+ correct token/],
  ["monitor-not-sleep", "sleep-loop", false, /sleep\/poll loop/],
  ["monitor-not-sleep", "tail-grep", true, /event-driven-bash \+ correct token/],
  ["monitor-not-sleep", "answer-then-ack-exit", true, /monitor \+ correct token/],
  ["monitor-not-sleep", "look-first", true, /monitor \+ correct token/],
  ["monitor-not-sleep", "poll-while-monitoring", false, /polled 1x/],
  ["resume-finished", "resume", true, /resumed via subagent-resume$/],
  ["resume-finished", "send-then-resume", true, /resumed via subagent-resume-after-agent_message/],
  ["resume-finished", "send-only", false, /resumed via agent_message-send-only/],
  ["supervisor-reply", "reply", true, /replied; child applied it/],
  ["supervisor-reply", "send", false, /answered via agent_message:send/],
];

describe("tail-grep timing regressions", () => {
  it("regression: system tail exits after READY even when the service writes nothing else", async () => {
    const systemPath = `/usr/bin:/bin:${process.env.PATH ?? ""}`;
    for (const { path, mode } of [systemPath, process.env.PATH ?? systemPath].flatMap((path) =>
      ["ready-now", "ready-later", "grep-failure"].map((mode) => ({ path, mode })))) {
      const expectedCode = mode === "grep-failure" ? 7 : 0;
      const cwd = mkdtempSync("/tmp/eval-tail-");
      writeFileSync(join(cwd, "service.log"), mode === "ready-later" ? "starting service\n" : "starting service\nREADY token=RACE1234\n");
      if (expectedCode !== 0) {
        mkdirSync(join(cwd, "bin"));
        writeFileSync(join(cwd, "bin", "grep"), "#!/bin/sh\necho fixture-grep-failure >&2\nexit 7\n", { mode: 0o700 });
      }
      // Hosted macOS uses BSD tail; a local Homebrew GNU tail masks this bug.
      const child = spawn("/bin/sh", ["-c", TAIL_GREP_COMMAND], {
        cwd, detached: true, env: {
          ...process.env, TMPDIR: cwd,
          PATH: `${expectedCode ? `${join(cwd, "bin")}:` : ""}${path}`,
        },
      });
      let output = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      let timer: NodeJS.Timeout | undefined;
      const writer = mode === "ready-later" ? setTimeout(() => {
        writeFileSync(join(cwd, "service.log"), "READY token=RACE1234\n", { flag: "a" });
      }, 200) : undefined;
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`tail/grep command did not exit: ${JSON.stringify({ mode, path, output, stderr })}`)), 3000);
          }),
        ]);
        assert.equal(code, expectedCode, "cleanup must preserve grep's success/failure status");
        assert.equal(output, expectedCode === 0 ? "READY token=RACE1234\n" : "");
        assert.equal(stderr, expectedCode === 0 ? "" : "fixture-grep-failure\n");
        assert.deepEqual(readdirSync(cwd).sort(), expectedCode === 0 ? ["service.log"] : ["bin", "service.log"], "command must leave no temporary files");
      } finally {
        clearTimeout(timer);
        clearTimeout(writer);
        // A leaked producer can hold stdio open even after its shell exited.
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group already exited */ }
        await exited;
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
  it("regression: READY delivered before foreground return is answered without a wake", async () => {
    const original = getScenario("monitor-not-sleep");
    const scenario = {
      ...original,
      // Synthetic timing only: production scenario budgets/grader stay unchanged.
      timeoutMs: 12_000,
      quietMs: 100,
      famulusConfig: { foregroundBudgetMs: 5000 },
      setup(cwd: string, secretDir: string) {
        writeFileSync(join(cwd, "service.log"), "starting service\n");
        return {
          prompt: "Wait for READY in service.log, then tell me the token.",
          background: () => spawn("sh", ["-c", "sleep 0.2; echo RACE1234 >> \"$1/ready\"; echo 'READY token=RACE1234' >> \"$2/service.log\"", "fixture", secretDir, cwd], { stdio: "ignore" }),
        };
      },
    };
    await withDiagnostics(async (diagnostics) => {
      const r = await episode("monitor-not-sleep", "tail-grep", diagnostics, scenario);
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.grade.pass, true, JSON.stringify(r.grade));
      assert.match(r.grade.reason, /event-driven-bash \+ correct token/);
      const items = itemsFromEvents(readFileSync(r.transcriptPath!, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
      const result = toolResults(items).find((item) => item.toolName === "bash");
      assert.ok(result && !result.isError);
      assert.match(result.text, /READY token=RACE1234/);
      assert.notEqual(result.details?.backgrounded, true);
      assert.equal(wakes(items).length, 0, "must exercise foreground completion, not the usual wake path");
      assert.equal(r.usage.calls, 2, "initial tool call then immediate token reply");
    });
  });

  it("regression: READY overtaking the waiting step is answered (provider input replay)", async () => {
    const scenario = {
      ...getScenario("monitor-not-sleep"),
      timeoutMs: 12_000,
      quietMs: 100,
      setup: () => ({ prompt: "Replay READY timing inputs." }),
      done: (items: Parameters<Scenario["done"]>[0]) =>
        items.some((item) => item.kind === "assistant" && item.text === "READY replays passed"),
      grade: ({ items }: Parameters<Scenario["grade"]>[0]) => ({
        pass: items.some((item) => item.kind === "assistant" && item.text === "READY replays passed"),
        reason: "READY replies asserted inside the real faux provider", metrics: {},
      }),
    };
    await withDiagnostics(async (diagnostics) => {
      const r = await episode("monitor-not-sleep", "tail-grep", diagnostics, scenario, join(import.meta.dirname, "fixtures", "tail-grep-replay.ts"));
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.grade.pass, true, JSON.stringify(r.grade));
    });
  });
});

describe("graders on scripted behaviors", { concurrency: true }, () => {
  for (const [scenario, behavior, pass, reason] of CASES) {
    it(`${scenario}/${behavior} → ${pass ? "PASS" : "FAIL"}`, async () => {
      await withDiagnostics(async (diagnostics) => {
        const r = await episode(scenario, behavior, diagnostics);
        assert.equal(r.error, undefined, `episode error: ${r.error}`);
        assert.equal(r.grade.pass, pass, `${r.grade.reason} ${JSON.stringify(r.grade.metrics)}`);
        assert.match(r.grade.reason, reason, JSON.stringify(r.grade.metrics));
      });
    });
  }
});
