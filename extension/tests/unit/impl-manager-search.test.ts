import { describe, expect, it } from "vitest";
import { describeManagerSearch } from "../../src/config";

describe("degraded-startup manager search description", () => {
  it("names every place looked and flags configured paths that do not exist", () => {
    const text = describeManagerSearch(
      { managerPath: "/nope/pbs-manager" } as never,
      "/home/u/.pi/agent/pbs",
      { PBS_MANAGER_PATH: "/also/missing" },
    );
    expect(text).toContain("config managerPath /nope/pbs-manager (missing, ignored)");
    expect(text).toContain("PBS_MANAGER_PATH /also/missing (missing, ignored)");
    expect(text).toContain("/home/u/.pi/agent/pbs/bin/pbs-manager");
    expect(text).toContain("on PATH");
  });
});
