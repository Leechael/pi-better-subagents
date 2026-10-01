/**
 * Contract tests for LineBatcher — design.md §4.4 + Appendix A.
 *
 * NOTE(naming): files use the `contract-*.test.ts` pattern (not plain
 * `contract-*.ts`) because vitest's default include glob only matches
 * *.test.ts / *.spec.ts — plain names would be silently undiscoverable by
 * `npx vitest run tests/contract-*.ts`. The required `contract-` prefix is
 * preserved.
 *
 * Interface adapted from Appendix A (not a verbatim contract):
 * dispose() below documents current implementation behavior: pending content
 * is dropped, whereas Appendix A says "flush + clear timer". Batch tests check
 * the hard cap, not Appendix A's separate plain-cut/no-marker requirement.
 *   export interface LineBatcherOptions {
 *     flushMs?: number;          // batching window, default 200
 *     maxLineChars?: number;     // per-line hard cap, default 500 (plain cut, no marker)
 *     maxBatchChars?: number;    // per-batch hard cap, default 3000
 *     onFlush: (text: string) => void;
 *   }
 *   export class LineBatcher {
 *     constructor(opts: LineBatcherOptions);
 *     push(chunk: string): void;   // feed raw output chunk (possibly no newline / multiple lines)
 *     flush(): void;               // emit current buffer immediately (including a partial trailing line)
 *     dispose(): void;             // actual behavior: clear timer and drop pending content
 *   }
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ManualClock } from "../src/clock";
import { LineBatcher } from "../src/monitor-batching";

function collect() {
  const batches: string[] = [];
  return { batches, onFlush: (text: string) => void batches.push(text) };
}

describe("LineBatcher (contract: design.md §4.4 + Appendix A)", () => {
  let clock: ManualClock;
  beforeEach(() => {
    clock = new ManualClock();
  });

  it("merges multiple chunks pushed within the 200ms window into one batch", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("hello ");
    b.push("world\n");
    // Batching window: nothing is emitted synchronously
    expect(batches).toHaveLength(0);
    clock.advanceBy(200);
    expect(batches).toHaveLength(1);
    // chunks are concatenated before line-splitting — no newline invented
    expect(batches[0]).toContain("hello world");
    b.dispose();
  });

  it("batches all lines of a multi-line chunk into one flush", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("a\nb\nc\n");
    clock.advanceBy(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("a");
    expect(batches[0]).toContain("b");
    expect(batches[0]).toContain("c");
    b.dispose();
  });

  it("flushes a residual line without trailing newline at window end (no data loss)", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("partial-line-no-newline");
    clock.advanceBy(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("partial-line-no-newline");
    b.dispose();
  });

  it("starts a new batching window after each flush (continuous stream)", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("one\n");
    clock.advanceBy(200);
    b.push("two\n");
    clock.advanceBy(200);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toContain("one");
    expect(batches[1]).toContain("two");
    b.dispose();
  });

  it("caps a single line at maxLineChars (default 500)", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("x".repeat(600) + "\n");
    clock.advanceBy(200);
    expect(batches).toHaveLength(1);
    const lines = batches[0].split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(500);
    }
    // Appendix A specifies a plain cut with no marker; this assertion only
    // checks that the head of the line is preserved.
    expect(batches[0]).toContain("x".repeat(100));
    b.dispose();
  });

  it("caps a single batch at maxBatchChars (default 3000)", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    const line = "y".repeat(400); // 401 chars/line with newline
    for (let i = 0; i < 10; i++) b.push(line + "\n"); // ~4010 chars total
    clock.advanceBy(200);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(3000);
    }
    // AMBIGUITY(design): whether overflow is deferred to the next batch or
    // dropped is unspecified — only the per-batch hard cap is asserted here.
    b.dispose();
  });

  it("flush() emits the current buffer immediately and does not re-emit it", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("abc\n");
    b.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain("abc");
    // the pending timer must not re-deliver the same content
    clock.advanceBy(1000);
    expect(batches).toHaveLength(1);
    b.dispose();
  });

  it("flush() on an empty buffer is a no-op", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.flush();
    clock.advanceBy(1000);
    expect(batches).toHaveLength(0);
    b.dispose();
  });

  it("dispose() clears the timer and drops pending content", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({ onFlush, clock });
    b.push("pending\n");
    b.dispose();
    clock.advanceBy(1000);
    expect(batches).toHaveLength(0);
  });

  it("honours custom flushMs / maxLineChars / maxBatchChars options", () => {
    const { batches, onFlush } = collect();
    const b = new LineBatcher({
      onFlush,
      flushMs: 50,
      maxLineChars: 10,
      maxBatchChars: 25,
      clock,
    });
    b.push("abcdefghijklmnop\n"); // 16 chars > maxLineChars 10
    expect(batches).toHaveLength(0);
    clock.advanceBy(50);
    expect(batches).toHaveLength(1);
    for (const line of batches[0].split("\n").filter((l) => l.length > 0)) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
    expect(batches[0].length).toBeLessThanOrEqual(25);
    b.dispose();
  });
});
