import { describe, it } from "vitest";
import * as TestClock from "effect/TestClock";

/**
 * The current Promise runner schedules through global setTimeout, so Effect's
 * TestClock cannot drive these scenarios yet. Keep the cases visible and
 * activate them as the Effect runner/registry ports replace that implementation.
 */
describe.skip("Effect TestClock scenarios for the existing ChildRunner contract", () => {
  it.skip("interrupts only the current generation when its hard timeout expires", () => {
    void TestClock.adjust;
  });

  it.skip("pauses stall time during tool execution and a pending supervisor decision", () => {
    void TestClock.adjust;
  });

  it.skip("restarts the stall deadline on child activity and settles once after resume", () => {
    void TestClock.adjust;
  });

  it.skip("keeps registry admission FIFO and releases a permit on fail-fast cancellation", () => {
    void TestClock.adjust;
  });

  it.skip("disposes active children and releases each registry permit exactly once", () => {
    void TestClock.adjust;
  });
});
