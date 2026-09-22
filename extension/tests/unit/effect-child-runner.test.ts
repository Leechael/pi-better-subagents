import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/TestClock";
import * as TestServices from "effect/TestServices";
import { EffectChildRunner } from "../../src/subagent/effect-runner";
import type { ChildRunRequest } from "../../src/subagent/types";
import { SessionFactory, WORKER_AGENT } from "./subagent-fakes";

function testServices() {
  return Layer.provide(
    TestClock.defaultTestClock,
    Layer.succeedContext(TestServices.liveServices),
  );
}

function runWithTestClock<A>(f: (clock: TestClock.TestClock) => Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(Effect.provide(TestClock.testClockWith(f), testServices()));
}

function request(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    childId: "ch_effect01",
    runId: "run_effect01",
    name: "worker",
    prompt: "work",
    agent: WORKER_AGENT,
    timeoutMs: 60_000,
    depth: 1,
    ...overrides,
  };
}

const flushQueuedTimerCallback = () =>
  Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

function awaitScheduledTimer(clock: TestClock.TestClock, stage: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* clock.sleeps).length > 0) return;
      yield* Effect.yieldNow();
    }
    throw new Error(`Effect timer did not register with TestClock: ${stage}`);
  });
}


describe("EffectChildRunner with TestClock", () => {
  it("settles a hard timeout and aborts the active child without wall-clock waiting", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 1_000 })));
        yield* awaitScheduledTimer(clock, "initial timeout");
        yield* clock.adjust(1_000);
        yield* flushQueuedTimerCallback();
        const outcome = yield* Effect.promise(() => handle.result);
        return { handle, outcome };
      }),
    );
    expect(result.outcome).toMatchObject({ status: "interrupted", error: "timeout" });
    expect(result.outcome.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(result.outcome.durationMs).toBeLessThan(1_100);
    expect(result.handle.status()).toBe("interrupted");
    expect(factory.sessions[0].aborts).toBe(1);
  });

  it("disposes the session, settles result waiters, and closes generation timers", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        yield* awaitScheduledTimer(clock, "active generation");
        handle.dispose();
        const outcome = yield* Effect.promise(() => handle.result);
        yield* clock.adjust(500);
        yield* flushQueuedTimerCallback();
        return { outcome, status: handle.status() };
      }),
    );
    expect(result.outcome).toMatchObject({ status: "interrupted", error: "disposed" });
    expect(result.status).toBe("interrupted");
    expect(factory.sessions[0].disposed).toBe(true);
  });

  it("resets the stall deadline after child activity", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        yield* awaitScheduledTimer(clock, "initial stall");
        yield* clock.adjust(400);
        factory.sessions[0].event();
        yield* awaitScheduledTimer(clock, "activity-reset stall");
        yield* clock.adjust(400);
        const beforeDeadline = handle.status();
        yield* clock.adjust(100);
        yield* flushQueuedTimerCallback();
        const outcome = yield* Effect.promise(() => handle.result);
        return { beforeDeadline, outcome };
      }),
    );
    expect(result.beforeDeadline).toBe("running");
    expect(result.outcome).toMatchObject({ status: "failed", error: "stalled" });
  });

  it("does not rearm a stall watchdog from events after settlement", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = "quick";
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        const outcome = yield* Effect.promise(() => handle.result);
        factory.sessions[0].event();
        yield* clock.adjust(1_000);
        yield* flushQueuedTimerCallback();
        return { outcome, status: handle.status() };
      }),
    );
    expect(result.outcome).toMatchObject({ status: "completed", text: "quick" });
    expect(result.status).toBe("completed");
  });

  it("updates lastEventAt from child activity using the injected clock", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 2_000, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        const atStart = handle.lastEventAt();
        yield* clock.adjust(200);
        factory.sessions[0].event();
        const afterEvent = handle.lastEventAt();
        factory.sessions[0].complete();
        yield* Effect.promise(() => handle.result);
        return { atStart, afterEvent };
      }),
    );
    expect(result.afterEvent).toBeGreaterThan(result.atStart);
  });

  it("starts an independently timed generation after a timeout and resume", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 1_000 })));
        const emit = (factory.sessions[0] as unknown as { emit: (event: { type: string }) => void }).emit.bind(
          factory.sessions[0],
        );
        emit({ type: "tool_execution_start" });
        yield* awaitScheduledTimer(clock, "generation one timeout");
        yield* clock.adjust(1_000);
        yield* flushQueuedTimerCallback();
        emit({ type: "tool_execution_end" });
        const first = yield* Effect.promise(() => handle.result);
        yield* Effect.promise(() => handle.resume("again"));
        yield* awaitScheduledTimer(clock, "generation two");
        yield* clock.adjust(500);
        yield* flushQueuedTimerCallback();
        const second = yield* Effect.promise(() => handle.result);
        return { first, second };
      }),
    );
    expect(result.first).toMatchObject({ status: "interrupted", error: "timeout" });
    expect(result.second).toMatchObject({ status: "failed", error: "stalled" });
    expect(factory.sessions[0].prompts).toHaveLength(2);
  });

  it("pauses the stall deadline during a pending supervisor decision", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        yield* awaitScheduledTimer(clock, "initial stall");
        const controls = handle as unknown as { pauseStall(): void; resumeStall(): void };
        controls.pauseStall();
        yield* clock.adjust(2_000);
        const whilePaused = handle.status();
        controls.resumeStall();
        yield* awaitScheduledTimer(clock, "resumed stall");
        yield* clock.adjust(499);
        const beforeDeadline = handle.status();
        yield* clock.adjust(1);
        yield* flushQueuedTimerCallback();
        const outcome = yield* Effect.promise(() => handle.result);
        return { whilePaused, beforeDeadline, outcome };
      }),
    );
    expect(result.whilePaused).toBe("running");
    expect(result.beforeDeadline).toBe("running");
    expect(result.outcome).toMatchObject({ status: "failed", error: "stalled" });
  });

  it("pauses the stall deadline during a tool and restarts it on tool completion", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    factory.configure = (session) => {
      // Avoid FakeChildSession's immediate message_start event so the runner's
      // initial stall fiber has registered before the activity scenario begins.
      session.prompt = async (text) => {
        session.prompts.push(text);
        session.streaming = true;
        await session.waitForIdle();
      };
    };
    const result = await runWithTestClock((clock) =>
      Effect.gen(function* () {
        const runner = new EffectChildRunner({ createSession: factory.fn, stallMs: 500, clock });
        const handle = yield* Effect.promise(() => runner.start(request({ timeoutMs: 0 })));
        yield* awaitScheduledTimer(clock, "initial stall");
        const emit = (factory.sessions[0] as unknown as { emit: (event: { type: string }) => void }).emit.bind(
          factory.sessions[0],
        );
        emit({ type: "tool_execution_start" });
        yield* clock.adjust(2_000);
        const whileToolRuns = handle.status();
        emit({ type: "tool_execution_end" });
        yield* awaitScheduledTimer(clock, "rearmed stall");
        yield* clock.adjust(500);
        yield* flushQueuedTimerCallback();
        const outcome = yield* Effect.promise(() => handle.result);
        return { handle, outcome, whileToolRuns };
      }),
    );
    expect(result.whileToolRuns).toBe("running");
    expect(result.outcome).toMatchObject({ status: "failed", error: "stalled" });
    expect(result.handle.status()).toBe("failed");
    expect(factory.sessions[0].aborts).toBe(1);
  });
});
