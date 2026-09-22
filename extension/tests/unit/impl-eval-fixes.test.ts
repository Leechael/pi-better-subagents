import { describe, expect, it } from "vitest";
import {
  applyBehaviorGuidelines,
  BEHAVIOR_GUIDELINES_SECTION,
  wakePromptFromSections,
} from "../../src/behavior-guidelines";

describe("wake turns keep behavior guidelines", () => {
  it("writes a persistent section and does not replace other extensions' sections", () => {
    const options: { sections: Record<string, string> } = { sections: { other_extension: "keep me" } };
    applyBehaviorGuidelines(options);
    expect(options.sections.other_extension).toBe("keep me");
    expect(options.sections[BEHAVIOR_GUIDELINES_SECTION]).toContain("<task-notification>");
    // A triggerTurn wake does not call before_agent_start. It sees the persisted sections.
    const wake = wakePromptFromSections(options.sections);
    expect(wake).toContain("<task-notification>");
    expect(wake).toContain("other_extension");
    expect(wake).not.toContain("forceSystemPrompt");
  });
});

