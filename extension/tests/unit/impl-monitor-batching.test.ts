import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineBatcher, RateLimiter } from "../../src/monitor-batching";

describe("LineBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function collect(opts: Partial<ConstructorParameters<typeof LineBatcher>[0]> = {}) {
    const batches: string[] = [];
    const batcher = new LineBatcher({ onFlush: (text) => batches.push(text), ...opts });
    return { batches, batcher };
  }

  it("coalesces pushes within the flush window into one batch", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    batcher.push("two\n");
    batcher.push("three\n");
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(batches).toEqual(["one\ntwo\nthree"]);
    batcher.dispose();
  });

  it("emits separate batches when pushes are further apart than the window", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    vi.advanceTimersByTime(200);
    batcher.push("two\n");
    vi.advanceTimersByTime(200);
    expect(batches).toEqual(["one", "two"]);
    batcher.dispose();
  });

  it("concatenates chunks before splitting lines (no invented newlines)", () => {
    const { batches, batcher } = collect();
    batcher.push("hel");
    batcher.push("lo\nworld\n");
    vi.advanceTimersByTime(200);
    expect(batches).toEqual(["hello\nworld"]);
    batcher.dispose();
  });

  it("drains an unterminated trailing line at window end (no data loss)", () => {
    const { batches, batcher } = collect();
    batcher.push("done\ntail-without-newline");
    vi.advanceTimersByTime(200);
    expect(batches).toEqual(["done\ntail-without-newline"]);
    batcher.dispose();
  });

  it("flush() emits the buffer immediately without waiting for the window", () => {
    const { batches, batcher } = collect();
    batcher.push("abc\n");
    batcher.flush();
    expect(batches).toEqual(["abc"]);
    // The pending timer must not re-deliver the same content.
    vi.advanceTimersByTime(1000);
    expect(batches).toEqual(["abc"]);
    batcher.dispose();
  });

  it("caps individual lines at maxLineChars", () => {
    const { batches, batcher } = collect({ maxLineChars: 5 });
    batcher.push("1234567890\n");
    vi.advanceTimersByTime(200);
    expect(batches).toEqual(["12345"]);
    batcher.dispose();
  });

  it("caps a batch at maxBatchChars keeping the tail", () => {
    const { batches, batcher } = collect({ maxBatchChars: 10 });
    batcher.push("aaaa\nbbbb\ncccc\n");
    vi.advanceTimersByTime(200);
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
    vi.advanceTimersByTime(1000);
    expect(batches).toEqual([]);
    batcher.dispose();
  });

  it("stops emitting after dispose", () => {
    const { batches, batcher } = collect();
    batcher.push("one\n");
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    batcher.push("two\n");
    batcher.flush();
    expect(batches).toEqual([]);
  });

  it("honors a custom flush window", () => {
    const { batches, batcher } = collect({ flushMs: 50 });
    batcher.push("x\n");
    vi.advanceTimersByTime(49);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual(["x"]);
    batcher.dispose();
  });
});

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to capacity tokens, then refuses", () => {
    const limiter = new RateLimiter({ capacity: 3, refillIntervalMs: 1000, refillAmount: 1 });
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    limiter.dispose();
  });

  it("refills tokens at the configured interval", () => {
    const limiter = new RateLimiter({ capacity: 2, refillIntervalMs: 2000, refillAmount: 1 });
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    vi.advanceTimersByTime(4000);
    // Refill never exceeds capacity.
    expect(limiter.tryConsume(2)).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    limiter.dispose();
  });

  it("supports consuming multiple tokens at once", () => {
    const limiter = new RateLimiter({ capacity: 5 });
    expect(limiter.tryConsume(4)).toBe(true);
    expect(limiter.tryConsume(2)).toBe(false);
    expect(limiter.tryConsume(1)).toBe(true);
    limiter.dispose();
  });

  it("uses the documented defaults (capacity 10, +1 per 2s)", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(limiter.tryConsume()).toBe(true);
    limiter.dispose();
  });

  it("refuses consumption after dispose", () => {
    const limiter = new RateLimiter({ capacity: 1 });
    limiter.dispose();
    expect(limiter.tryConsume()).toBe(false);
  });
});
