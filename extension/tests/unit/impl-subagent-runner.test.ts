import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessRunner } from "../../src/subagent/runner";
import type { ChildRunRequest } from "../../src/subagent/types";
import { FakeChildSession, SessionFactory, tick, WORKER_AGENT } from "./subagent-fakes";

function makeReq(overrides: Partial<ChildRunRequest> = {}): ChildRunRequest {
  return {
    childId: "ch_test0001",
    runId: "run_test0001",
    name: "worker-1",
    prompt: "do the thing",
    agent: WORKER_AGENT,
    timeoutMs: 60_000,
    depth: 1,
    ...overrides,
  };
}

describe("InProcessRunner", () => {
  it("completes with the last assistant text", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = "all done";
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("all done");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(factory.sessions[0].prompts).toEqual(["do the thing"]);
    expect(handle.status()).toBe("completed");
  });

  it('maps empty output to "(no output)"', async () => {
    const factory = new SessionFactory();
    factory.autoComplete = "";
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    const result = await handle.result;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("(no output)");
  });

  it("fails the child when the prompt throws", async () => {
    const factory = new SessionFactory();
    factory.configure = (s) => {
      s.promptError = new Error("no API key");
    };
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no API key");
  });

  it("fails the child when session creation throws", async () => {
    const factory = new SessionFactory();
    factory.createError = new Error("pi package unavailable");
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("pi package unavailable");
  });

  it("steer/followUp deliver to a running session and throw once terminal", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null; // manual completion
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    expect(handle.status()).toBe("running");
    await handle.steer("focus");
    await handle.followUp("and then");
    expect(factory.sessions[0].steers).toEqual(["focus"]);
    expect(factory.sessions[0].followUps).toEqual(["and then"]);
    factory.sessions[0].complete("finished");
    await handle.result;
    await expect(handle.steer("too late")).rejects.toThrow(/not running/);
    await expect(handle.followUp("too late")).rejects.toThrow(/not running/);
  });

  it("interrupt aborts and resolves interrupted", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    await handle.interrupt();
    const result = await handle.result;
    expect(result.status).toBe("interrupted");
    expect(factory.sessions[0].aborts).toBe(1);
    expect(handle.status()).toBe("interrupted");
    // Second interrupt is a no-op.
    await handle.interrupt();
    expect(factory.sessions[0].aborts).toBe(1);
  });

  it("resume re-prompts the same session and exposes a new result promise", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = "first";
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    const first = await handle.result;
    expect(first.text).toBe("first");
    expect(factory.sessions).toHaveLength(1);

    factory.sessions[0].autoComplete = null;
    await handle.resume("keep going");
    expect(handle.status()).toBe("running");
    expect(factory.sessions).toHaveLength(1); // same session object
    expect(factory.sessions[0].prompts).toEqual(["do the thing", "keep going"]);

    const secondPromise = handle.result;
    factory.sessions[0].complete("second");
    const second = await secondPromise;
    expect(second.status).toBe("completed");
    expect(second.text).toBe("second");
    // The first generation's promise stays resolved with the first result.
    await expect(Promise.resolve(first)).resolves.toMatchObject({ text: "first" });
  });

  it("resume on a running child throws", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    await expect(handle.resume("nope")).rejects.toThrow(/still running/);
    factory.sessions[0].complete();
    await handle.result;
  });

  it("invokes the acquire hook per generation and releases on settle", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = "one";
    let acquired = 0;
    let released = 0;
    const runner = new InProcessRunner({
      createSession: factory.fn,
      acquire: async () => {
        acquired++;
        return () => {
          released++;
        };
      },
    });
    const handle = await runner.start(makeReq());
    await handle.result;
    expect(acquired).toBe(1);
    expect(released).toBe(1);

    factory.sessions[0].autoComplete = "two";
    await handle.resume("again");
    await handle.result;
    expect(acquired).toBe(2);
    expect(released).toBe(2);
  });

  it("cancels the child when admission rejects", async () => {
    const factory = new SessionFactory();
    const runner = new InProcessRunner({
      createSession: factory.fn,
      acquire: async () => {
        throw new Error("cancelled (fail_fast)");
      },
    });
    const handle = await runner.start(makeReq());
    const result = await handle.result;
    expect(result.status).toBe("interrupted");
    expect(result.error).toContain("fail_fast");
    expect(factory.sessions).toHaveLength(0); // no session was created
  });

  describe("timers (fake clock)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hard timeout aborts and resolves interrupted with error=timeout", async () => {
      const factory = new SessionFactory();
      factory.autoComplete = null;
      const runner = new InProcessRunner({ createSession: factory.fn });
      const handle = await runner.start(makeReq({ timeoutMs: 1000 }));
      expect(handle.status()).toBe("running");
      await vi.advanceTimersByTimeAsync(1000);
      const result = await handle.result;
      expect(result.status).toBe("interrupted");
      expect(result.error).toBe("timeout");
      expect(factory.sessions[0].aborts).toBe(1);
    });

    it("stall watchdog aborts after stallMs without events", async () => {
      const factory = new SessionFactory();
      factory.autoComplete = null;
      const runner = new InProcessRunner({ createSession: factory.fn, stallMs: 500 });
      const handle = await runner.start(makeReq());
      await vi.advanceTimersByTimeAsync(500);
      const result = await handle.result;
      expect(result.status).toBe("failed");
      expect(result.error).toBe("stalled");
      expect(factory.sessions[0].aborts).toBe(1);
    });

    it("session events reset the stall watchdog", async () => {
      const factory = new SessionFactory();
      factory.autoComplete = null;
      const runner = new InProcessRunner({ createSession: factory.fn, stallMs: 500 });
      const handle = await runner.start(makeReq());
      const session = factory.sessions[0];
      await vi.advanceTimersByTimeAsync(400);
      session.event(); // resets the watchdog at t=400
      await vi.advanceTimersByTimeAsync(400); // t=800, 400 since last event
      expect(handle.status()).toBe("running");
      await vi.advanceTimersByTimeAsync(100); // t=900, 500 since last event
      const result = await handle.result;
      expect(result.status).toBe("failed");
      expect(result.error).toBe("stalled");
    });

    it("events after settle do not re-arm the watchdog", async () => {
      const factory = new SessionFactory();
      factory.autoComplete = "quick";
      const runner = new InProcessRunner({ createSession: factory.fn, stallMs: 500 });
      const handle = await runner.start(makeReq());
      await handle.result;
      factory.sessions[0].event();
      await vi.advanceTimersByTimeAsync(1000);
      expect(handle.status()).toBe("completed"); // unchanged
    });

    it("lastEventAt tracks session events", async () => {
      const factory = new SessionFactory();
      factory.autoComplete = null;
      const runner = new InProcessRunner({ createSession: factory.fn });
      const handle = await runner.start(makeReq());
      const atStart = handle.lastEventAt();
      await vi.advanceTimersByTimeAsync(2000);
      factory.sessions[0].event();
      expect(handle.lastEventAt()).toBeGreaterThan(atStart);
      factory.sessions[0].complete();
      await handle.result;
    });
  });

  it("dispose releases the session and never hangs result waiters", async () => {
    const factory = new SessionFactory();
    factory.autoComplete = null;
    const runner = new InProcessRunner({ createSession: factory.fn });
    const handle = await runner.start(makeReq());
    handle.dispose();
    const result = await handle.result;
    expect(result.status).toBe("interrupted");
    expect(factory.sessions[0].disposed).toBe(true);
    await tick();
  });
});
