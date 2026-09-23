import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/clock";
import { LineBatcher, RateLimiter } from "../../src/monitor-batching";

describe("LineBatcher", () => {
  let clock: ManualClock;
  beforeEach(() => {
    clock = new ManualClock();
  });

  function collect(opts: Partial<ConstructorParameters<typeof LineBatcher>[0]> = {}) {
    const batches: string[] = [];
    const batcher = new LineBatcher({ onFlush: (text) => batches.push(text), clock, ...opts });
    return { batches, batcher };
  }

  it("coalesces pushes within the flush window into one batch", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    batcher.push("two\n");
    batcher.push("three\n");
    expect(batches).toEqual([]);
    clock.advanceBy(200);
    expect(batches).toEqual(["one\ntwo\nthree"]);
    batcher.dispose();
  });

  it("emits separate batches when pushes are further apart than the window", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    clock.advanceBy(200);
    batcher.push("two\n");
    clock.advanceBy(200);
    expect(batches).toEqual(["one", "two"]);
    batcher.dispose();
  });

  it("concatenates chunks before splitting lines (no invented newlines)", () => {
    const { batches, batcher } = collect();
    batcher.push("hel");
    batcher.push("lo\nworld\n");
    clock.advanceBy(200);
    expect(batches).toEqual(["hello\nworld"]);
    batcher.dispose();
  });

  it("drains an unterminated trailing line at window end (no data loss)", () => {
    const { batches, batcher } = collect();
    batcher.push("done\ntail-without-newline");
    clock.advanceBy(200);
    expect(batches).toEqual(["done\ntail-without-newline"]);
    batcher.dispose();
  });

  it("flush() emits the buffer immediately without waiting for the window", () => {
    const { batches, batcher } = collect();
    batcher.push("abc\n");
    batcher.flush();
    expect(batches).toEqual(["abc"]);
    // The pending timer must not re-deliver the same content.
    clock.advanceBy(1000);
    expect(batches).toEqual(["abc"]);
    batcher.dispose();
  });

  it("caps individual lines at maxLineChars", () => {
    const { batches, batcher } = collect({ maxLineChars: 5 });
    batcher.push("1234567890\n");
    clock.advanceBy(200);
    expect(batches).toEqual(["12345"]);
    batcher.dispose();
  });

  it("caps a batch at maxBatchChars keeping the tail", () => {
    const { batches, batcher } = collect({ maxBatchChars: 10 });
    batcher.push("aaaa\nbbbb\ncccc\n");
    clock.advanceBy(200);
    expect(batches).toHaveLength(1);
    expect(batches[0].length).toBe(10);
    expect(batches[0].startsWith("…")).toBe(true);
    expect(batches[0].endsWith("cccc")).toBe(true);
    batcher.dispose();
  });

  it("does not emit empty batches", () => {
    const { batches, batcher } = collect();
    batcher.push("");
    batcher.flush();
    clock.advanceBy(1000);
    expect(batches).toEqual([]);
    batcher.dispose();
  });

  it("stops emitting after dispose", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    batcher.dispose();
    clock.advanceBy(1000);
    batcher.push("two\n");
    batcher.flush();
    expect(batches).toEqual([]);
  });

  it("honors a custom flush window", () => {
    const { batches, batcher } = collect({ flushMs: 50 });
    batcher.push("x\n");
    clock.advanceBy(49);
    expect(batches).toEqual([]);
    clock.advanceBy(1);
    expect(batches).toEqual(["x"]);
    batcher.dispose();
  });
});

describe("RateLimiter", () => {
  let clock: ManualClock;
  beforeEach(() => {
    clock = new ManualClock();
  });

  it("allows up to capacity tokens, then refuses", () => {
    const limiter = new RateLimiter({ capacity: 3, refillIntervalMs: 1000, refillAmount: 1, clock });
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    limiter.dispose();
  });

  it("refills tokens at the configured interval", () => {
    const limiter = new RateLimiter({ capacity: 2, refillIntervalMs: 2000, refillAmount: 1, clock });
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    clock.advanceBy(2000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    clock.advanceBy(4000);
    // Refill never exceeds capacity.
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    limiter.dispose();
  });

  it("supports consuming multiple tokens at once", () => {
    const limiter = new RateLimiter({ capacity: 5, clock });
    expect(limiter.tryConsume(4)).toBe(true);
    expect(limiter.tryConsume(2)).toBe(false);
    expect(limiter.tryConsume(1)).toBe(true);
    limiter.dispose();
  });

  it("uses the documented defaults (capacity 10, +1 per 2s)", () => {
    const limiter = new RateLimiter({ clock });
    for (let i = 0; i < 10; i++) expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    clock.advanceBy(2000);
    expect(limiter.tryConsume()).toBe(true);
    limiter.dispose();
  });

  it("refuses consumption after dispose", () => {
    const limiter = new RateLimiter({ capacity: 1, clock });
    limiter.dispose();
    expect(limiter.tryConsume()).toBe(false);
  });
});
