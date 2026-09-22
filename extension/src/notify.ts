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
import { formatTaskNotification, type TaskExitInfo } from "./format";
import { PBS_WAKE_CUSTOM_TYPE, type WakeItem } from "./wake";

/** @deprecated emitted type is pbs-wake; kept until the renderer switches. */
export const TASK_NOTIFICATION_CUSTOM_TYPE = "pbs-task-notification";

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
}


export class NotifyCenter {
  private readonly deps: NotifyCenterDeps;
  private readonly batchMs: number;
  private pendingExits: TaskExitInfo[] = [];
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(deps: NotifyCenterDeps) {
    this.deps = deps;
    this.batchMs = deps.batchMs ?? 200;
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

  /** Flush any pending task exit notifications now. */
  flush(): void {
    this.clearTimer();
    this.flushExits();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.pendingExits = [];
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushExits();
    }, this.batchMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
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
