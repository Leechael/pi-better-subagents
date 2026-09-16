/**
 * Contract tests for RateLimiter — design.md §4.4 + Appendix A.
 *
 * Contract under test (Appendix A, verbatim):
 *   export interface RateLimiterOptions {
 *     capacity?: number;          // 默认 10
 *     refillIntervalMs?: number;  // 默认 2000
 *     refillAmount?: number;      // 默认 1
 *   }
 *   export class RateLimiter {
 *     constructor(opts?: RateLimiterOptions);
 *     tryConsume(n?: number): boolean;  // 默认 n=1; 不足返回 false
 *     dispose(): void;
 *   }
 *
 * §4.4: token bucket(容量 10,每 2s +1).
 * ASSUMPTION: the bucket starts full (standard token-bucket semantics).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../src/monitor-batching";

describe("RateLimiter (contract: design.md §4.4 + Appendix A)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to capacity (default 10) then returns false when exhausted", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(r.tryConsume()).toBe(true);
    }
    expect(r.tryConsume()).toBe(false);
    r.dispose();
  });

  it("tryConsume() defaults to n=1", () => {
    const r = new RateLimiter({ capacity: 2 });
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(false);
    r.dispose();
  });

  it("tryConsume(n) consumes exactly n tokens", () => {
    const r = new RateLimiter(); // capacity 10
    expect(r.tryConsume(4)).toBe(true); // 6 left
    expect(r.tryConsume(6)).toBe(true); // 0 left
    expect(r.tryConsume(1)).toBe(false);
    r.dispose();
  });

  it("a failed tryConsume is all-or-nothing (no partial drain)", () => {
    const r = new RateLimiter(); // capacity 10
    expect(r.tryConsume(11)).toBe(false); // over capacity — must fail
    expect(r.tryConsume(10)).toBe(true); // bucket untouched by the failure
    expect(r.tryConsume(1)).toBe(false);
    r.dispose();
  });

  it("refills +1 token every 2s (defaults)", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 10; i++) r.tryConsume();
    expect(r.tryConsume()).toBe(false);

    vi.advanceTimersByTime(2000); // +1
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(false);

    vi.advanceTimersByTime(4000); // +2
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(false);
    r.dispose();
  });

  it("refill never exceeds capacity", () => {
    const r = new RateLimiter();
    expect(r.tryConsume()).toBe(true); // 9 left
    vi.advanceTimersByTime(60_000); // would be +30 uncapped
    for (let i = 0; i < 10; i++) {
      expect(r.tryConsume()).toBe(true);
    }
    expect(r.tryConsume()).toBe(false);
    r.dispose();
  });

  it("honours custom capacity / refillIntervalMs / refillAmount", () => {
    const r = new RateLimiter({
      capacity: 3,
      refillIntervalMs: 1000,
      refillAmount: 2,
    });
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(true);
    expect(r.tryConsume()).toBe(false);
    vi.advanceTimersByTime(1000); // +2
    expect(r.tryConsume(2)).toBe(true);
    expect(r.tryConsume()).toBe(false);
    r.dispose();
  });

  it("dispose() stops refilling", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 10; i++) r.tryConsume();
    r.dispose();
    vi.advanceTimersByTime(60_000);
    expect(r.tryConsume()).toBe(false);
  });
});
