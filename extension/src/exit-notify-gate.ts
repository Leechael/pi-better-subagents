/**
 * A task can exit in the same socket read as a wait reply of done:false.
 * The exit event is dispatched before markNotifyOnExit runs, so the wake is
 * dropped. Stash that exit and fire it when the mark arrives late.
 */
import { realClock, type Clock } from "./clock";

export interface StashedExit<T> {
  taskId: string;
  event: T;
}

export class ExitNotifyGate<T> {
  private readonly notify = new Set<string>();
  private readonly recent = new Map<string, T>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly stamped = new Map<string, number>();

  constructor(opts: { ttlMs?: number; clock?: Clock } = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.clock = opts.clock ?? realClock;
  }

  private now(): number {
    return this.clock.now();
  }

  /**
   * Record that this task should wake the parent when it exits.
   * If the exit already arrived, return it so the caller can notify now.
   */
  mark(taskId: string): T | undefined {
    this.prune();
    this.notify.add(taskId);
    const prior = this.recent.get(taskId);
    if (prior === undefined) return undefined;
    this.recent.delete(taskId);
    this.stamped.delete(taskId);
    this.notify.delete(taskId);
    return prior;
  }

  /**
   * An exit event arrived. "notify" if it was already marked, "stash" if the
   * mark may still be coming, "ignore" for monitors (they have their own path).
   */
  onExit(taskId: string, event: T, isMonitor: boolean): "notify" | "stash" | "ignore" {
    if (isMonitor) return "ignore";
    this.prune();
    if (this.notify.has(taskId)) {
      this.notify.delete(taskId);
      return "notify";
    }
    this.recent.set(taskId, event);
    this.stamped.set(taskId, this.now());
    return "stash";
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, at] of this.stamped) {
      if (at < cutoff) {
        this.stamped.delete(id);
        this.recent.delete(id);
      }
    }
  }
}
