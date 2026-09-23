import assert from "node:assert/strict";
import { it } from "node:test";
import { segmentVerdict, stopDecision, wilson } from "./stats.ts";

it("wilson matches known values", () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 1e-3 && Math.abs(w.hi - 0.9433) < 1e-3, JSON.stringify(w));
  const zero = wilson(0, 5);
  assert.equal(zero.lo, 0);
  assert.ok(zero.hi > 0.4 && zero.hi < 0.45);
});

it("stops variants early only when the interval is decisive", () => {
  const base = { passes: 10, n: 10 };
  assert.equal(stopDecision({ passes: 0, n: 3 }, base, false, 10), "drop-certain");
  assert.equal(stopDecision({ passes: 3, n: 3 }, base, false, 10), "continue");
  assert.equal(stopDecision({ passes: 1, n: 2 }, base, false, 10), "continue");
  assert.equal(stopDecision({ passes: 0, n: 1 }, { passes: 0, n: 6 }, false, 10), "continue"); // 0/6: hi=0.39
  assert.equal(stopDecision({ passes: 0, n: 1 }, { passes: 0, n: 6 }, false, 6), "floor"); // baseline complete
  assert.equal(stopDecision({ passes: 0, n: 1 }, { passes: 0, n: 20 }, false, 30), "floor"); // hi=0.16
  assert.equal(stopDecision({ passes: 5, n: 10 }, base, false, 10), "done");
  assert.equal(stopDecision({ passes: 2, n: 3 }, { passes: 3, n: 3 }, true, 3), "done");
});

it("segment verdicts use the 20pp point-estimate rule", () => {
  assert.equal(segmentVerdict([-0.1, 0, 0.05]), "slop");
  assert.equal(segmentVerdict([-0.1, -0.2]), "load-bearing");
  assert.equal(segmentVerdict([]), "untested");
});
