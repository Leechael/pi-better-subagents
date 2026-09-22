import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildBashTool } from "../../src/subagent/child-bash";
import { childSessionCreateOptions } from "../../src/subagent/pi-runtime";

const customTool = (name: string, parameters = Type.Object({})) => ({
  name,
  label: name,
  description: name,
  parameters,
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  },
});

describe("child custom tools", () => {
  it("keeps injected tools active under an agent allowlist and replaces bash without backgrounding", async () => {
    const customTools = [
      customTool("contact_supervisor"),
      customTool("agent_message"),
      createChildBashTool({
        getClient: () => null,
        home: "/tmp",
        sessionId: () => "parent",
        sessionEnv: () => ({}),
        trackTask: () => {},
      }),
    ];
    const options = childSessionCreateOptions({
      cwd: "/tmp",
      model: undefined,
      thinkingLevel: "off",
      tools: ["read", "bash"],
      customTools,
    });
    const { session } = await createAgentSession({
      ...options,
      agentDir: "/tmp/pbs-child-tools-agent-dir",
      sessionManager: SessionManager.inMemory("/tmp"),
    } as never);
    try {
      expect(session.getActiveToolNames()).toEqual(["read", "bash", "contact_supervisor", "agent_message"]);
      expect(session.getToolDefinition("bash")?.parameters).not.toHaveProperty("properties.run_in_background");
    } finally {
      session.dispose();
    }
  });
});
