/**
 * Faux-model harness extension (loaded into a real `pi` via `-e`).
 *
 * Registers provider `faux` with model `faux-1`, whose responses come from a
 * scenario script module named by PBS_FAUX_SCRIPT. Each LLM call consumes the
 * next scripted step; once the script is exhausted the script's `fallback`
 * step answers (or, without one, an error message that the test can detect).
 *
 * Every call is appended to PBS_FAUX_TRACE (JSONL) with the step index and
 * the full request context, so tests can assert what the model actually saw
 * (post-extension-hooks, i.e. after any ablation).
 */
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FauxScript, FauxStep } from "../e2e/faux-dsl.ts";

export default async function fauxHarness(pi: ExtensionAPI): Promise<void> {
  const scriptPath = process.env.PBS_FAUX_SCRIPT;
  if (!scriptPath) return; // registered only when a script is provided
  const tracePath = process.env.PBS_FAUX_TRACE;
  const mod = (await import(scriptPath)) as { default: FauxScript | (() => FauxScript) };
  const script: FauxScript = typeof mod.default === "function" ? mod.default() : mod.default;

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux Model" }] });
  let index = 0;

  const run = async (step: FauxStep, context: { messages: unknown[] }, n: number) =>
    typeof step === "function" ? await step({ messages: context.messages as never, call: n }) : step;

  const dispatcher = async (context: { messages: unknown[] }) => {
    faux.appendResponses([dispatcher as never]); // never run dry; we decide below
    const n = index++;
    const scripted = n < script.steps.length;
    const step = scripted ? script.steps[n] : script.fallback;
    if (tracePath) {
      appendFileSync(
        tracePath,
        `${JSON.stringify({ call: n, scripted, fallback: !scripted && !!step, ts: Date.now(), messages: context.messages })}\n`,
      );
    }
    if (!step) {
      return fauxAssistantMessage(`FAUX SCRIPT EXHAUSTED at call ${n}`, {
        stopReason: "error",
        errorMessage: `faux script exhausted at call ${n}`,
      });
    }
    return run(step, context, n);
  };
  faux.setResponses([dispatcher as never]);
  pi.registerProvider(faux.provider);
}
