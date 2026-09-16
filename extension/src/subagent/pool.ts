/**
 * Execution engines for the subagent tool (design doc §4.6):
 *
 * - `runTasks`: parallel worker pool — `concurrency` slots, results preserved
 *   in tasks-array ordinal order, `failFast` stops only not-yet-started tasks
 *   (already-started ones run to completion).
 * - `runChain`: sequential execution with `{previous}` / `{outputs.<label>}`
 *   interpolation. Unknown label references are rejected up front (before any
 *   child starts). A failed step aborts the chain; remaining steps are marked
 *   interrupted.
 *
 * Both are pi-free and registry-free: the caller injects `startChild`.
 */
import type { ChildResult } from "./types";

export interface StartChildContext {
  /**
   * True once a fail_fast cancellation is in effect. Checked by the registry
   * after global admission, so children queued for a concurrency slot are
   * still cancelled before they spawn a session.
   */
  cancelled: () => boolean;
}

export interface RunTasksOptions<T> {
  concurrency: number; // worker slots, >= 1
  failFast: boolean;
  startChild: (task: T, ordinal: number, ctx: StartChildContext) => Promise<ChildResult>;
}

function cancelledResult(): ChildResult {
  return { status: "interrupted", text: "", error: "cancelled (fail_fast)", durationMs: 0 };
}

function failureResult(err: unknown): ChildResult {
  return {
    status: "failed",
    text: "",
    error: err instanceof Error ? err.message : String(err),
    durationMs: 0,
  };
}

/** Run all tasks through a worker pool; the result array follows task order. */
export async function runTasks<T>(
  tasks: readonly T[],
  opts: RunTasksOptions<T>,
): Promise<ChildResult[]> {
  const results = new Array<ChildResult>(tasks.length);
  const workerCount = Math.max(1, Math.min(Math.floor(opts.concurrency), tasks.length));
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const ordinal = next++;
      if (ordinal >= tasks.length) return;
      if (opts.failFast && failed) {
        // Never submitted: the registry reconciles the pending record via
        // finalizeRun; here we only fill the result slot.
        results[ordinal] = cancelledResult();
        continue;
      }
      try {
        results[ordinal] = await opts.startChild(tasks[ordinal], ordinal, {
          cancelled: () => opts.failFast && failed,
        });
      } catch (err) {
        results[ordinal] = failureResult(err);
      }
      if (results[ordinal].status !== "completed") failed = true;
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface ChainStep {
  prompt: string;
  label?: string;
}

export interface RunChainOptions<T extends ChainStep> {
  startChild: (step: T, ordinal: number, interpolatedPrompt: string) => Promise<ChildResult>;
}

const REF_PATTERN = /\{previous\}|\{outputs\.([A-Za-z0-9_-]+)\}/g;

/**
 * Validate every step's references before anything starts (§4.6: unknown
 * label reference -> immediate error, nothing launches).
 */
export function validateChainSteps(steps: readonly ChainStep[]): void {
  const defined = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const prompt = steps[i].prompt;
    for (const match of prompt.matchAll(REF_PATTERN)) {
      if (match[0] === "{previous}") {
        if (i === 0) {
          throw new Error(`chain step ${i + 1}: {previous} referenced but there is no previous step`);
        }
      } else {
        const label = match[1];
        if (!defined.has(label)) {
          const known = [...defined].join(", ") || "(none)";
          throw new Error(
            `chain step ${i + 1}: unknown label reference {outputs.${label}} — labels defined by earlier steps: ${known}`,
          );
        }
      }
    }
    const label = steps[i].label;
    if (label !== undefined) {
      if (defined.has(label)) {
        throw new Error(`chain step ${i + 1}: duplicate label "${label}"`);
      }
      defined.add(label);
    }
  }
}

/** Substitute {previous} and {outputs.<label>} with prior step result texts. */
export function interpolateChainPrompt(
  prompt: string,
  previous: string | undefined,
  outputs: ReadonlyMap<string, string>,
): string {
  return prompt.replace(REF_PATTERN, (whole, label: string | undefined) => {
    if (whole === "{previous}") return previous ?? "";
    if (label === undefined) {
      // Should be unreachable: the pattern only matches {previous} or
      // {outputs.<label>}; fail loudly rather than silently.
      throw new Error(`invalid chain reference ${whole}`);
    }
    const text = outputs.get(label);
    if (text === undefined) {
      // Should be unreachable after validateChainSteps; fail loudly anyway.
      throw new Error(`unknown label reference {outputs.${label}}`);
    }
    return text;
  });
}

/**
 * Run steps sequentially. A non-completed step aborts the chain: remaining
 * steps are marked interrupted without being started.
 */
export async function runChain<T extends ChainStep>(
  steps: readonly T[],
  opts: RunChainOptions<T>,
): Promise<ChildResult[]> {
  validateChainSteps(steps);
  const results = new Array<ChildResult>(steps.length);
  const outputs = new Map<string, string>();
  let previous: string | undefined;
  let abortedAt = -1;

  for (let i = 0; i < steps.length; i++) {
    if (abortedAt >= 0) {
      results[i] = {
        status: "interrupted",
        text: "",
        error: `skipped: chain aborted after step ${abortedAt + 1} failed`,
        durationMs: 0,
      };
      continue;
    }
    const interpolated = interpolateChainPrompt(steps[i].prompt, previous, outputs);
    let result: ChildResult;
    try {
      result = await opts.startChild(steps[i], i, interpolated);
    } catch (err) {
      result = failureResult(err);
    }
    results[i] = result;
    if (result.status !== "completed") {
      abortedAt = i;
      continue;
    }
    previous = result.text;
    const label = steps[i].label;
    if (label !== undefined) outputs.set(label, result.text);
  }
  return results;
}
