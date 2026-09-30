import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { ExitWatchdog } from "../../src/exit-watchdog";

// A backgrounded command's wake came only from a task_exited event, or from
// syncWithManager when the model looked (task_list, /tasks, task_stop) or the
// client reconnected. Once reconnect gave up, an agent that obeyed "end your
// turn" was never woken: only polling recovered the wake.

const settle = () => new Promise<void>((r) => setImmediate(r));

// ManualClock fires synchronously; let each tick's promise settle before the next.
async function step(clock: ManualClock, ms: number, every = 30_000): Promise<void> {
  for (let left = ms; left > 0; left -= every) {
    await settle();
    clock.advanceBy(Math.min(every, left));
  }
  await settle();
}

describe("ExitWatchdog", () => {
  function setup() {
    const clock = new ManualClock(0);
    const pending = new Set<string>();
    let ticks = 0;
    let release: (() => void) | null = null;
    let hold = false;
    const dog = new ExitWatchdog({
      clock,
      intervalMs: 30_000,
      hasPending: () => pending.size > 0,
      tick: async () => {
        ticks++;
        if (hold) await new Promise<void>((r) => (release = r));
      },
    });
    return {
      clock,
      pending,
      dog,
      ticks: () => ticks,
      hold: () => (hold = true),
      release: () => {
        hold = false;
        release?.();
      },
    };
  }

  it("ticks while a task awaits its wake, with no model action", async () => {
    const t = setup();
    t.pending.add("sh_1");
    t.dog.arm();
    await step(t.clock, 29_999);
    expect(t.ticks()).toBe(0);
    await step(t.clock, 1);
    expect(t.ticks()).toBe(1);
    await step(t.clock, 60_000);
    expect(t.ticks()).toBe(3);
  });

  it("stops once nothing is pending, and re-arms for the next task", async () => {
    const t = setup();
    t.pending.add("sh_1");
    t.dog.arm();
    await step(t.clock, 30_000);
    t.pending.clear();
    await step(t.clock, 330_000);
    expect(t.ticks()).toBe(1);
    t.pending.add("sh_2");
    t.dog.arm();
    await step(t.clock, 30_000);
    expect(t.ticks()).toBe(2);
  });

  it("arming twice keeps one timer", () => {
    const t = setup();
    t.pending.add("sh_1");
    t.dog.arm();
    t.dog.arm();
    t.clock.advanceBy(30_000);
    expect(t.ticks()).toBe(1);
  });

  it("skips a tick while the previous one is still running", async () => {
    const t = setup();
    t.pending.add("sh_1");
    t.hold();
    t.dog.arm();
    await step(t.clock, 90_000);
    expect(t.ticks()).toBe(1);
    t.release();
    await step(t.clock, 30_000);
    expect(t.ticks()).toBe(2);
  });

  it("dispose stops ticking even with work pending", () => {
    const t = setup();
    t.pending.add("sh_1");
    t.dog.arm();
    t.dog.dispose();
    t.clock.advanceBy(300_000);
    expect(t.ticks()).toBe(0);
  });
});
