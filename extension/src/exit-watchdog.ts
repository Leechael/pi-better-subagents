/**
 * Keeps backgrounded commands' wakes alive without the model's help.
 *
 * The prompt tells the agent to end its turn after backgrounding a command.
 * Its wake normally comes from task_exited; a lost event is recovered by
 * syncWithManager, which otherwise runs only when someone looks (task_list,
 * /tasks, task_stop) or on reconnect. After reconnect gives up nothing looks,
 * so an agent that obeyed would never be woken. While any wake is pending,
 * this ticks on its own.
 */
import type { Clock, ClockTimer } from "./clock";

export const EXIT_WATCHDOG_INTERVAL_MS = 30_000;

export interface ExitWatchdogOptions {
  clock: Clock;
  intervalMs?: number;
  hasPending: () => boolean;
  /** Reconnect if needed and settle ended tasks (delivering their wakes). */
  tick: () => Promise<unknown>;
}

export class ExitWatchdog {
  private timer: ClockTimer;
  private armed = false;
  private inFlight = false;

  constructor(private readonly opts: ExitWatchdogOptions) {}

  /** Start ticking if not already; call whenever a task starts awaiting its wake. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.timer = this.opts.clock.setInterval(
      () => this.onTick(),
      this.opts.intervalMs ?? EXIT_WATCHDOG_INTERVAL_MS,
    );
  }

  dispose(): void {
    if (!this.armed) return;
    this.armed = false;
    this.opts.clock.clearInterval(this.timer);
  }

  private onTick(): void {
    if (!this.opts.hasPending()) {
      this.dispose();
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    void this.opts
      .tick()
      .catch(() => {})
      .finally(() => {
        this.inFlight = false;
      });
  }
}
