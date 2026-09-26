import { describe, expect, it } from "vitest";
import { shouldNotifyTaskExit } from "../../src/task-exit-notify";

describe("shouldNotifyTaskExit", () => {
  it("never notifies for monitor tasks (MonitorRegistry owns them)", () => {
    expect(
      shouldNotifyTaskExit({
        taskId: "mon_abc",
        isMonitor: true,
        notifyOnExit: new Set(["mon_abc"]),
      }),
    ).toBe(false);
  });

  it("notifies when parent bash marked the task for exit wake", () => {
    expect(
      shouldNotifyTaskExit({
        taskId: "sh_bg",
        isMonitor: false,
        notifyOnExit: new Set(["sh_bg"]),
      }),
    ).toBe(true);
  });

  it("does not notify for sync-awaited shells (child-bash / parent fg)", () => {
    // Child-bash and parent foreground waits share the session connection and
    // still receive task_exited; without an opt-in they must not wake the parent
    // as a "Background command" <task-notification>.
    expect(
      shouldNotifyTaskExit({
        taskId: "sh_child",
        isMonitor: false,
        notifyOnExit: new Set(),
      }),
    ).toBe(false);
  });
});
