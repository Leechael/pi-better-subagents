/**
 * Monitor output batching primitives (design doc §4.4, Appendix A).
 *
 * LineBatcher turns arbitrary output chunks into batched line payloads:
 * chunks are split on newlines, complete lines are capped per line, and
 * emissions are coalesced over a 200ms window with a per-batch size cap.
 *
 * RateLimiter is a token bucket used to throttle monitor event injection.
 */
import { realClock, type Clock, type ClockTimer } from "./clock";

export interface LineBatcherOptions {
  flushMs?: number; // batching window, default 200
  maxLineChars?: number; // per-line cap, default 500
  maxBatchChars?: number; // per-batch cap, default 3000
  onFlush: (text: string) => void;
  clock?: Clock;
}

export class LineBatcher {
  private readonly flushMs: number;
  private readonly maxLineChars: number;
  private readonly maxBatchChars: number;
  private readonly onFlush: (text: string) => void;
  private readonly clock: Clock;

  private partial = ""; // trailing bytes not yet terminated by \n
  private lines: string[] = []; // complete lines awaiting emission
  private timer: ClockTimer | null = null;
  private disposed = false;

  constructor(opts: LineBatcherOptions) {
    this.flushMs = opts.flushMs ?? 200;
    this.maxLineChars = opts.maxLineChars ?? 500;
    this.maxBatchChars = opts.maxBatchChars ?? 3000;
    this.onFlush = opts.onFlush;
    this.clock = opts.clock ?? realClock;
  }

  /** Feed a raw output chunk (may contain no/newlines or multiple lines). */
  push(chunk: string): void {
    if (this.disposed || chunk.length === 0) return;
    const combined = this.partial + chunk;
    const parts = combined.split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(this.capLine(line));
    }
    if (this.lines.length > 0 || this.partial.length > 0) this.schedule();
  }

  /**
   * Immediately emit the current buffer when non-empty, including any
   * unterminated trailing line. Used when a monitored process exits.
   */
  flush(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.emit();
  }

  /** Clear the pending timer and drop buffered content. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.lines = [];
    this.partial = "";
  }

  private capLine(line: string): string {
    if (line.length <= this.maxLineChars) return line;
    return line.slice(0, this.maxLineChars);
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      // Window end drains everything, including an unterminated trailing
      // line (no data loss); a fresh window starts on the next push.
      this.emit();
    }, this.flushMs);
    this.clock.unref?.(this.timer);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    const lines = this.lines;
    const partial = this.partial.length > 0 ? this.capLine(this.partial) : "";
    if (lines.length === 0 && partial.length === 0) return;
    this.lines = [];
    this.partial = "";

    let text = partial.length > 0 ? [...lines, partial].join("\n") : lines.join("\n");
    if (text.length > this.maxBatchChars) {
      // Keep the tail: for monitoring, the most recent lines matter most.
      text = `…${text.slice(-(this.maxBatchChars - 1))}`;
    }
    if (text.length > 0) this.onFlush(text);
  }
}

export interface RateLimiterOptions {
  capacity?: number; // default 10
  refillIntervalMs?: number; // default 2000
  refillAmount?: number; // default 1
  clock?: Clock;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillAmount: number;
  private tokens: number;
  private readonly interval: ClockTimer;
  private readonly clock: Clock;
  private disposed = false;

  constructor(opts?: RateLimiterOptions) {
    this.capacity = opts?.capacity ?? 10;
    this.refillAmount = opts?.refillAmount ?? 1;
    const refillIntervalMs = opts?.refillIntervalMs ?? 2000;
    this.clock = opts?.clock ?? realClock;
    this.tokens = this.capacity;
    this.interval = this.clock.setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillAmount);
    }, refillIntervalMs);
    this.clock.unref?.(this.interval);
  }

  /** Consume `n` tokens (default 1); returns false when insufficient. */
  tryConsume(n: number = 1): boolean {
    if (this.disposed) return false;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.clock.clearInterval(this.interval);
  }
}
