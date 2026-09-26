import { describe, expect, it } from "vitest";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { BEHAVIOR_GUIDELINES, CHILD_BEHAVIOR_GUIDELINES } from "../../src/behavior-guidelines";
import { childSessionCreateOptions } from "../../src/subagent/pi-runtime";

describe("child system prompt", () => {
  it("contains child guidance and excludes the parent's background-task section", async () => {
    const options = childSessionCreateOptions({
      cwd: "/tmp",
      model: undefined,
      thinkingLevel: "off",
      tools: ["read", "bash"],
      customTools: [
        {
          name: "contact_supervisor",
          label: "Contact supervisor",
          description: "Ask the parent for a decision or report progress.",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        },
        {
          name: "agent_message",
          label: "Agent message",
          description: "Message a sibling.",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        },
      ],
    });
    const { session } = await createAgentSession({
      ...options,
      agentDir: "/tmp/pbs-child-guidelines-agent-dir",
      sessionManager: SessionManager.inMemory("/tmp"),
    } as never);
    try {
      expect(session.systemPrompt).toContain(CHILD_BEHAVIOR_GUIDELINES);
      expect(session.systemPrompt).not.toContain(BEHAVIOR_GUIDELINES);
    } finally {
      session.dispose();
    }
  });
});
