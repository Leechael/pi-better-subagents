import { describe, expect, it } from "vitest";
import {
  applyBehaviorGuidelines,
  BEHAVIOR_GUIDELINES_SECTION,
  wakePromptFromSections,
} from "../../src/behavior-guidelines";
import { childSessionCreateOptions } from "../../src/subagent/pi-runtime";

describe("wake turns keep behavior guidelines", () => {
  it("writes a persistent section and does not replace other extensions' sections", () => {
    const options: { sections: Record<string, string> } = { sections: { other_extension: "keep me" } };
    applyBehaviorGuidelines(options);
    expect(options.sections.other_extension).toBe("keep me");
    expect(options.sections[BEHAVIOR_GUIDELINES_SECTION]).toContain("<pbs-wake");
    // A triggerTurn wake does not call before_agent_start. It sees the persisted sections.
    const wake = wakePromptFromSections(options.sections);
    expect(wake).toContain("<pbs-wake");
    expect(wake).toContain("other_extension");
    expect(wake).not.toContain("forceSystemPrompt");
  });
});

describe("child sessions reuse the parent model runtime", () => {
  it("passes the parent's modelRuntime into createAgentSession options", () => {
    const runtime = { id: "parent-runtime" };
    const options = childSessionCreateOptions({
      cwd: "/tmp",
      model: { provider: "ext", id: "custom" },
      thinkingLevel: "low",
      tools: ["read"],
      modelRuntime: runtime,
    });
    expect(options.modelRuntime).toBe(runtime);
    expect(options.cwd).toBe("/tmp");
  });
});

