import { describe, expect, it } from "vitest";
import { ManualClock, TimerScope } from "../../src/clock";

describe("ManualClock", () => {
  it("runs equal-deadline timers in insertion order and runs newly due timers during advance", () => {
    const clock = new ManualClock(100);
    const events: string[] = [];
    clock.setTimeout(() => {
      events.push("first");
      clock.setTimeout(() => events.push("nested"), 0);
    }, 20);
    clock.setTimeout(() => events.push("second"), 20);

    clock.advanceBy(20);

    expect(events).toEqual(["first", "second", "nested"]);
    expect(clock.now()).toBe(120);
  });

  it("lets one due callback clear another due timer before it executes", () => {
    const clock = new ManualClock();
    const events: string[] = [];
    let later: unknown;
    clock.setTimeout(() => {
      events.push("clearer");
      clock.clearTimeout(later);
    }, 10);
    later = clock.setTimeout(() => events.push("must-not-run"), 10);

    clock.advanceBy(10);

    expect(events).toEqual(["clearer"]);
  });

  it("catches up an interval once per deadline and stops it when cleared in its callback", () => {
    const clock = new ManualClock();
    const deadlines: number[] = [];
    let interval: unknown;
    interval = clock.setInterval(() => {
      deadlines.push(clock.now());
      if (deadlines.length === 3) clock.clearInterval(interval);
    }, 10);

    clock.advanceBy(100);

    expect(deadlines).toEqual([10, 20, 30]);
    expect(clock.now()).toBe(100);
  });

  it("resolves sleep from manual advancement without waiting for wall time", async () => {
    const clock = new ManualClock();
    let finished = false;
    const sleeping = clock.sleep(50).then(() => {
      finished = true;
    });
    clock.advanceBy(49);
    expect(finished).toBe(false);
    clock.advanceBy(1);
    await sleeping;
    expect(finished).toBe(true);
  });
});

describe("TimerScope", () => {
  it("clears its outstanding timeouts and intervals on dispose", () => {
    const clock = new ManualClock();
    const scope = new TimerScope(clock);
    const events: string[] = [];
    scope.setTimeout(() => events.push("timeout"), 10);
    scope.setInterval(() => events.push("interval"), 5);

    scope.dispose();
    scope.dispose();
    clock.advanceBy(20);

    expect(events).toEqual([]);
    expect(scope.size).toBe(0);
  });

  it("removes fired one-shot timers from ownership", () => {
    const clock = new ManualClock();
    const scope = new TimerScope(clock);
    let calls = 0;
    scope.setTimeout(() => calls++, 1);

    clock.advanceBy(1);

    expect(calls).toBe(1);
    expect(scope.size).toBe(0);
  });
});
