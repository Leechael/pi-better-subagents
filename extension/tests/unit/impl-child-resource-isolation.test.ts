import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { childResourceLoaderOptions, childSessionCreateOptions } from "../../src/subagent/pi-runtime";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("child resource isolation", () => {
  it("excludes globally discovered skills, extensions, prompts, themes and context files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pbs-child-resources-"));
    tempDirs.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "fake-home", ".pi", "agent");
    await mkdir(join(agentDir, "skills", "global-canary"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "global-canary", "SKILL.md"),
      "---\nname: global-canary\ndescription: fake global skill for child isolation\n---\nGLOBAL_CHILD_SKILL_CANARY",
    );
    await mkdir(cwd, { recursive: true });

    const loaderOptions = childResourceLoaderOptions({ cwd, agentDir });
    expect(loaderOptions).toMatchObject({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const resourceLoader = new DefaultResourceLoader(loaderOptions);
    await resourceLoader.reload();
    const options = childSessionCreateOptions({
      cwd,
      model: undefined,
      thinkingLevel: "off",
      tools: ["read"],
      resourceLoader,
    });
    const { session, extensionsResult } = await createAgentSession({
      ...options,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    } as never);
    try {
      expect(session.systemPrompt).not.toContain("GLOBAL_CHILD_SKILL_CANARY");
      expect(session.systemPrompt).not.toContain("global-canary");
      expect(extensionsResult.extensions).toHaveLength(0);
      expect(resourceLoader.getSkills().skills).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });
});
