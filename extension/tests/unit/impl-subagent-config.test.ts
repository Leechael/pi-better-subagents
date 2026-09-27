import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_CONFIG, resolveSubagentConfig } from "../../src/config";
import type { PbsConfig } from "../../src/config";

function makeConfig(subagent?: PbsConfig["subagent"]): PbsConfig {
  return {
    foregroundBudgetMs: 20000,
    subagentBudgetMs: 45000,
    managerPath: null,
    logLevel: "info",
    ...(subagent !== undefined ? { subagent } : {}),
  };
}

describe("resolveSubagentConfig stall retries", () => {
  it("defaults to one auto-resume after a 5s delay", () => {
    const resolved = resolveSubagentConfig(makeConfig());
    expect(resolved.stallRetries).toBe(1);
    expect(resolved.stallRetryDelayMs).toBe(5000);
    expect(DEFAULT_SUBAGENT_CONFIG.stallRetries).toBe(1);
  });

  it("reads stallRetries and stallRetryDelayMs from the subagent section", () => {
    const resolved = resolveSubagentConfig(
      makeConfig({ stallRetries: 3, stallRetryDelayMs: 1000 }),
    );
    expect(resolved.stallRetries).toBe(3);
    expect(resolved.stallRetryDelayMs).toBe(1000);
  });

  it("allows 0 retries (settle stalled immediately, the pre-fix behavior)", () => {
    const resolved = resolveSubagentConfig(makeConfig({ stallRetries: 0 }));
    expect(resolved.stallRetries).toBe(0);
  });

  it("floors fractional values and ignores negatives", () => {
    const resolved = resolveSubagentConfig(
      makeConfig({ stallRetries: 2.9, stallRetryDelayMs: -5 }),
    );
    expect(resolved.stallRetries).toBe(2);
    expect(resolved.stallRetryDelayMs).toBe(5000); // negative ignored
  });
});
