/**
 * Mailbox (design doc §4.7): per-run ring log of all comms traffic plus
 * per-child `need_decision` waiters.
 *
 * Anti-global-lock (pi-intercom lesson): every child gets its own waiter
 * entry with its own promise and its own timeout timer — children never
 * queue behind each other.
 */
import { realClock, type Clock, type ClockTimer } from "../clock";
import type { MailboxEntry } from "./types";

export const DEFAULT_MAILBOX_CAPACITY = 200;
export const DEFAULT_LOG_LIMIT = 20;
export const DEFAULT_DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/** Exact contract text (§4.7) returned to a child whose decision request times out. */
export const DECISION_TIMEOUT_MESSAGE =
  "Supervisor did not respond within 10 minutes; decide yourself and continue.";

export interface PendingDecisionRequest {
  childId: string;
  name: string;
  message: string;
  sinceMs: number;
}

interface Waiter {
  name: string;
  message: string;
  sinceMs: number;
  resolve: (reply: string) => void;
  timer: ClockTimer;
}

export interface MailboxOptions {
  /** Ring capacity per run. Default 200. */
  capacity?: number;
  /** need_decision timeout. Default 600_000 (10 min). */
  decisionTimeoutMs?: number;
  clock?: Clock;
}

export class Mailbox {
  private readonly capacity: number;
  private readonly decisionTimeoutMs: number;
  private readonly clock: Clock;
  private readonly rings = new Map<string, MailboxEntry[]>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(options: MailboxOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_MAILBOX_CAPACITY;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.clock = options.clock ?? realClock;
  }

  /**
   * Append an entry to a run's ring (oldest entries dropped past capacity).
   * Returns the stored entry; callers may later set `entry.reply` — the ring
   * holds the same object reference.
   */
  append(runId: string, entry: Omit<MailboxEntry, "ts"> & { ts?: number }): MailboxEntry {
    const full: MailboxEntry = {
      ts: entry.ts ?? this.clock.now(),
      from: entry.from,
      to: entry.to,
      kind: entry.kind,
      message: entry.message,
    };
    if (entry.reply !== undefined) full.reply = entry.reply;
    let ring = this.rings.get(runId);
    if (!ring) {
      ring = [];
      this.rings.set(runId, ring);
    }
    ring.push(full);
    if (ring.length > this.capacity) {
      ring.splice(0, ring.length - this.capacity);
    }
    return full;
  }

  /** Last `limit` entries of a run, chronological order. Default 20. */
  log(runId: string, limit: number = DEFAULT_LOG_LIMIT): MailboxEntry[] {
    const ring = this.rings.get(runId) ?? [];
    if (limit <= 0) return [];
    return ring.slice(Math.max(0, ring.length - limit));
  }

  hasPendingDecision(childId: string): boolean {
    return this.waiters.has(childId);
  }

  /**
   * Register this child's need_decision waiter and return the promise that
   * resolves with the supervisor's reply (or DECISION_TIMEOUT_MESSAGE after
   * the timeout). Independent per child — no global lock.
   *
   * Throws if the child already has a pending request (one at a time).
   */
  beginDecision(childId: string, name: string, message: string): Promise<string> {
    if (this.waiters.has(childId)) {
      throw new Error(
        `Child ${childId} already has a pending decision request; ` +
          "wait for the supervisor's reply before asking again.",
      );
    }
    let resolveFn!: (reply: string) => void;
    const promise = new Promise<string>((res) => {
      resolveFn = res;
    });
    const timer = this.clock.setTimeout(() => {
      if (this.waiters.delete(childId)) {
        resolveFn(DECISION_TIMEOUT_MESSAGE);
      }
    }, this.decisionTimeoutMs);
    this.waiters.set(childId, {
      name,
      message,
      sinceMs: this.clock.now(),
      resolve: resolveFn,
      timer,
    });
    return promise;
  }

  /**
   * Resolve a pending need_decision waiter with the supervisor's reply.
   * Returns false when the child has no pending request.
   */
  resolveDecision(childId: string, reply: string): boolean {
    const waiter = this.waiters.get(childId);
    if (!waiter) return false;
    this.waiters.delete(childId);
    this.clock.clearTimeout(waiter.timer);
    waiter.resolve(reply);
    return true;
  }

  pendingRequests(): PendingDecisionRequest[] {
    return [...this.waiters.entries()].map(([childId, w]) => ({
      childId,
      name: w.name,
      message: w.message,
      sinceMs: w.sinceMs,
    }));
  }

  /** Cancel all timers; outstanding waiters resolve with the timeout message. */
  dispose(): void {
    for (const waiter of this.waiters.values()) {
      this.clock.clearTimeout(waiter.timer);
      waiter.resolve(DECISION_TIMEOUT_MESSAGE);
    }
    this.waiters.clear();
  }
}
