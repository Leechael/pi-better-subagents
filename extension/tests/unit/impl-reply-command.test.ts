import { describe, expect, it } from "vitest";
import { resolveReplyCommand } from "../../src/comms/reply-command";

const pending = [
  { childId: "ch_a", name: "alpha", message: "drop the column?", sinceMs: 1 },
  { childId: "ch_b", name: "beta", message: "ship now?", sinceMs: 2 },
];

describe("/reply command parsing", () => {
  it("uses an explicit pending child id or name", () => {
    expect(resolveReplyCommand("ch_a yes, drop it", pending)).toEqual({ childId: "ch_a", message: "yes, drop it" });
    expect(resolveReplyCommand("beta wait", pending)).toEqual({ childId: "ch_b", message: "wait" });
  });

  it("treats all args as the decision when there is one pending request", () => {
    expect(resolveReplyCommand("yes, proceed", pending.slice(0, 1))).toEqual({
      childId: "ch_a",
      message: "yes, proceed",
    });
  });

  it("requires a target when multiple decisions are pending", () => {
    expect(resolveReplyCommand("yes", pending)).toMatchObject({ error: expect.stringContaining("Specify a pending child") });
  });

  it("shows pending choices and handles empty state", () => {
    expect(resolveReplyCommand("", pending)).toMatchObject({ error: expect.stringContaining("ch_a (alpha)") });
    expect(resolveReplyCommand("yes", [])).toEqual({ error: "No pending supervisor decisions." });
  });
});
