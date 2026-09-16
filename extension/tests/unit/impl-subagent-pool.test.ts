import { describe, expect, it } from "vitest";
import { interpolateChainPrompt, runChain, runTasks, validateChainSteps } from "../../src/subagent/pool";
import type { ChildResult } from "../../src/subagent/types";
import { tick } from "./subagent-fakes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ok(text: string): ChildResult {
  return { status: "completed", text, durationMs: 1 };
}

function failed(error: string): ChildResult {
  return { status: "failed", text: "", error, durationMs: 1 };
}

describe("runTasks", () => {
  it("preserves tasks-array ordinal order regardless of completion order", async () => {
    const gates = [deferred<ChildResult>(), deferred<ChildResult>(), deferred<ChildResult>()];
    const promise = runTasks(["a", "b", "c"], {
      concurrency: 3,
      failFast: false,
      startChild: (_task, ordinal) => gates[ordinal].promise,
    });
    await tick();
    gates[2].resolve(ok("third"));
    gates[0].resolve(ok("first"));
    gates[1].resolve(ok("second"));
    const results = await promise;
    expect(results.map((r) => r.text)).toEqual(["first", "second", "third"]);
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = new Map<number, ReturnType<typeof deferred<ChildResult>>>();
    const promise = runTasks([1, 2, 3, 4, 5], {
      concurrency: 2,
      failFast: false,
      startChild: (_task, ordinal) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const gate = deferred<ChildResult>();
        gates.set(ordinal, gate);
        return gate.promise.finally(() => active--);
      },
    });
    await tick();
    expect(active).toBe(2);
    // Resolve one gate at a time: each freed slot starts the next task,
    // whose gate only exists after microtasks flush.
    for (let i = 0; i < 5; i++) {
      gates.get(i)!.resolve(ok(`${i}`));
      await tick();
      expect(active).toBeLessThanOrEqual(2);
    }
    await promise;
    expect(maxActive).toBe(2);
  });

  it("fail_fast cancels not-yet-started tasks and lets started ones finish", async () => {
    const started: number[] = [];
    const slow = deferred<ChildResult>();
    const promise = runTasks(["slow", "boom", "never-1", "never-2"], {
      concurrency: 2,
      failFast: true,
      startChild: (_task, ordinal) => {
        started.push(ordinal);
        if (ordinal === 0) return slow.promise;
        return Promise.resolve(failed("boom"));
      },
    });
    await tick();
    // Task 2 failed; tasks 3 and 4 were never submitted.
    expect(started).toEqual([0, 1]);
    slow.resolve(ok("slow done"));
    const results = await promise;
    expect(results[0]).toMatchObject({ status: "completed", text: "slow done" });
    expect(results[1]).toMatchObject({ status: "failed", error: "boom" });
    expect(results[2]).toMatchObject({ status: "interrupted", error: "cancelled (fail_fast)" });
    expect(results[3]).toMatchObject({ status: "interrupted", error: "cancelled (fail_fast)" });
  });

  it("fail_fast cancellation is visible through the startChild context", async () => {
    const cancelledSeen: boolean[] = [];
    const slow = deferred<ChildResult>();
    const promise = runTasks(["slow", "boom"], {
      concurrency: 2,
      failFast: true,
      startChild: (_task, ordinal, ctx) => {
        if (ordinal === 0) return slow.promise;
        cancelledSeen.push(ctx.cancelled());
        return Promise.resolve(failed("boom"));
      },
    });
    await tick();
    expect(cancelledSeen).toEqual([false]);
    slow.resolve(ok("done"));
    await promise;
  });

  it("without fail_fast every task runs despite failures", async () => {
    const started: number[] = [];
    const results = await runTasks(["a", "b", "c"], {
      concurrency: 2,
      failFast: false,
      startChild: (_task, ordinal) => {
        started.push(ordinal);
        return Promise.resolve(ordinal === 1 ? failed("nope") : ok(`done-${ordinal}`));
      },
    });
    expect(started.sort()).toEqual([0, 1, 2]);
    expect(results.map((r) => r.status)).toEqual(["completed", "failed", "completed"]);
  });

  it("a throwing startChild becomes a failed result, not a rejection", async () => {
    const results = await runTasks(["a"], {
      concurrency: 1,
      failFast: false,
      startChild: () => Promise.reject(new Error("registry exploded")),
    });
    expect(results[0]).toMatchObject({ status: "failed", error: "registry exploded" });
  });
});

describe("chain", () => {
  it("interpolates {previous} and {outputs.<label>}", async () => {
    const prompts: string[] = [];
    const results = await runChain(
      [
        { prompt: "summarize the repo", label: "sum" },
        { prompt: "critique: {previous}" },
        { prompt: "combine {outputs.sum} with critique", label: "final" },
      ],
      {
        startChild: (_step, ordinal, interpolated) => {
          prompts.push(interpolated);
          return Promise.resolve(ok(`result-${ordinal}`));
        },
      },
    );
    expect(prompts).toEqual([
      "summarize the repo",
      "critique: result-0",
      "combine result-0 with critique",
    ]);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("rejects unknown label references before starting anything", async () => {
    let started = 0;
    await expect(
      runChain(
        [{ prompt: "a" }, { prompt: "use {outputs.nope}" }],
        {
          startChild: () => {
            started++;
            return Promise.resolve(ok("x"));
          },
        },
      ),
    ).rejects.toThrow(/unknown label reference \{outputs\.nope\}/);
    expect(started).toBe(0);
  });

  it("rejects {previous} in the first step", () => {
    expect(() => validateChainSteps([{ prompt: "{previous}" }])).toThrow(/no previous step/);
  });

  it("rejects duplicate labels", () => {
    expect(() =>
      validateChainSteps([
        { prompt: "a", label: "x" },
        { prompt: "b", label: "x" },
      ]),
    ).toThrow(/duplicate label "x"/);
  });

  it("a label may only reference earlier steps", () => {
    expect(() =>
      validateChainSteps([
        { prompt: "uses {outputs.later}" },
        { prompt: "b", label: "later" },
      ]),
    ).toThrow(/unknown label reference/);
  });

  it("stops the chain on failure and marks remaining steps interrupted", async () => {
    const started: number[] = [];
    const results = await runChain(
      [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }],
      {
        startChild: (_step, ordinal) => {
          started.push(ordinal);
          return Promise.resolve(ordinal === 0 ? failed("step failed") : ok("x"));
        },
      },
    );
    expect(started).toEqual([0]);
    expect(results[0].status).toBe("failed");
    expect(results[1]).toMatchObject({ status: "interrupted", error: "skipped: chain aborted after step 1 failed" });
    expect(results[2]).toMatchObject({ status: "interrupted" });
  });

  it("interpolateChainPrompt throws on unknown label at runtime (defensive)", () => {
    expect(() => interpolateChainPrompt("{outputs.x}", undefined, new Map())).toThrow(
      /unknown label reference/,
    );
  });
});
