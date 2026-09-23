/**
 * NotifyCenter (design doc §4.5): the single injection point for all
 * asynchronous events into the pi session.
 *
 * - idle  -> pi.sendMessage(msg, { triggerTurn: true })
 * - busy  -> pi.sendMessage(msg, { deliverAs: "steer" })
 * - task exit notifications are coalesced over a 200ms window into one
 *   <pbs-wake kind="task"> payload, and the same task/event pair is only
 *   ever delivered once.
 */
import { formatMonitorEvent, formatTaskNotification, type TaskExitInfo } from "./format";
import { PBS_WAKE_CUSTOM_TYPE, type WakeItem } from "./wake";
import { realClock, type Clock, type ClockTimer } from "./clock";


export interface NotifyMessage {
  customType: string;
  content: string;
  details?: unknown;
}

export interface NotifyCenterDeps {
  sendMessage: (
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { triggerTurn?: boolean; deliverAs?: "steer" },
  ) => void;
  isIdle: () => boolean;
  /** Batching window for task exit notifications (ms). Default 200. */
  batchMs?: number;
  /**
   * Background tasks still awaiting their own exit wake.
   * Read at flush time so siblings that exit in the same window are not listed.
   */
  listStillRunning?: () => WakeItem[];
  clock?: Clock;
}


export class NotifyCenter {
  private readonly deps: NotifyCenterDeps;
  private readonly batchMs: number;
  private readonly clock: Clock;
  private pendingExits: TaskExitInfo[] = [];
  private readonly pendingMonitors = new Map<
    string,
    { description: string; eventCount: number; lastEvent: string; droppedLines: number }
  >();
  private readonly seen = new Set<string>();
  private timer: ClockTimer | null = null;
  private disposed = false;

  constructor(deps: NotifyCenterDeps) {
    this.deps = deps;
    this.batchMs = deps.batchMs ?? 200;
    this.clock = deps.clock ?? realClock;
  }

  /**
   * Queue a task exit notification. Deduplicated by task id; merged with
   * other exits inside the batching window.
   */
  notifyTaskExit(info: TaskExitInfo): void {
    if (this.disposed) return;
    const key = `exit:${info.taskId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pendingExits.push(info);
    this.scheduleFlush();
  }

  /** Send a notification immediately, routed by idle/busy state. */
  notify(message: NotifyMessage): void {
    if (this.disposed) return;
    this.deliver(message);
  }

  /** Deliver monitor output immediately when idle, otherwise coalesce per monitor. */
  notifyMonitorEvent(description: string, taskId: string, event: string, droppedLines = 0): void {
    if (this.disposed) return;
    const pending = this.pendingMonitors.get(taskId);
    if (this.deps.isIdle() && !pending) {
      const wake = formatMonitorEvent(description, taskId, event, undefined, { droppedLines });
      this.deliver({ customType: wake.customType, content: wake.content, details: wake.details });
      return;
    }
    this.pendingMonitors.set(taskId, {
      description,
      eventCount: (pending?.eventCount ?? 0) + 1,
      lastEvent: event,
      droppedLines: (pending?.droppedLines ?? 0) + droppedLines,
    });
    if (this.deps.isIdle()) this.flushMonitorEvents();
  }

  /** Flush coalesced monitor output when the parent agent settles. */
  flushMonitorEvents(): void {
    if (this.disposed || !this.deps.isIdle() || this.pendingMonitors.size === 0) return;
    const pending = [...this.pendingMonitors.entries()];
    this.pendingMonitors.clear();
    for (const [taskId, item] of pending) {
      const summary = item.eventCount > 1
        ? `${item.eventCount} events · last: ${item.lastEvent}`
        : item.lastEvent;
      const wake = formatMonitorEvent(item.description, taskId, summary, undefined, {
        eventCount: item.eventCount,
        droppedLines: item.droppedLines,
      });
      this.deliver({ customType: wake.customType, content: wake.content, details: wake.details });
    }
  }

  /** Flush any pending task exit notifications now. */
  flush(): void {
    this.clearTimer();
    this.flushExits();
    this.flushMonitorEvents();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.pendingExits = [];
    this.pendingMonitors.clear();
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flushExits();
    }, this.batchMs);
    this.clock.unref?.(this.timer);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flushExits(): void {
    if (this.disposed || this.pendingExits.length === 0) return;
    const events = this.pendingExits;
    this.pendingExits = [];
    const wake = formatTaskNotification(events, this.deps.listStillRunning?.() ?? []);
    this.deliver({
      customType: PBS_WAKE_CUSTOM_TYPE,
      content: wake.content,
      details: wake.details,
    });
  }

  private deliver(message: NotifyMessage): void {
    const msg = { ...message, display: true };
    if (this.deps.isIdle()) {
      this.deps.sendMessage(msg, { triggerTurn: true });
    } else {
      this.deps.sendMessage(msg, { deliverAs: "steer" });
    }
  }
}
