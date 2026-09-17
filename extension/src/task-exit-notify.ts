/**
 * Decide whether a manager task_exited should become a parent-session
 * <task-notification> (design doc §4.2 / §4.5 / §4.6).
 *
 * - Monitors are handled by MonitorRegistry (not this path).
 * - Parent bash only opts in via markNotifyOnExit when it actually
 *   backgrounded the command (budget exceeded / run_in_background / lost contact).
 * - Child-bash always sync-waits and must not wake the parent — otherwise every
 *   subagent shell completion is mis-shown as a parent "Background command".
 */

export function shouldNotifyTaskExit(opts: {
  taskId: string;
  /** True when MonitorRegistry owns this task_id. */
  isMonitor: boolean;
  /** Task ids the parent bash marked for exit wake. */
  notifyOnExit: ReadonlySet<string>;
}): boolean {
  if (opts.isMonitor) return false;
  return opts.notifyOnExit.has(opts.taskId);
}
