import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

it("a sandbox in a long TMPDIR exposes a usable socket at its full configured path", {
  skip: process.platform !== "linux" && process.platform !== "darwin",
}, () => {
  const root = mkdtempSync("/tmp/socket-test-");
  // With the short sandbox prefix this leaves room for h/manager.sock on both
  // Linux (107 bytes) and macOS (103 bytes); the longer prefix exceeds both.
  const base = join(root, "x".repeat(74 - Buffer.byteLength(root) - 1));
  mkdirSync(base);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { lstatSync } from "node:fs";
      import { createConnection, createServer } from "node:net";
      import { join } from "node:path";
      // macOS normally forces /tmp. Select the TMPDIR branch in this child only,
      // exercising a real OS socket boundary without changing the parent's OS.
      if (process.platform === "darwin") {
        Object.defineProperty(process, "platform", { value: "linux" });
      }
      const { createSandbox } = await import(${JSON.stringify(new URL("./sandbox.ts", import.meta.url).href)});
      const sb = createSandbox();
      const path = join(sb.famulusHome, "manager.sock");
      const server = createServer((socket) => socket.end("ready"));
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, resolve);
        });
        // Node may silently truncate overlong Unix socket paths. A successful
        // Node-to-Node connect alone would therefore miss the regression.
        assert.ok(lstatSync(path).isSocket(), "socket must exist at the full configured path");
        const reply = await new Promise((resolve, reject) => {
          const client = createConnection(path);
          let data = "";
          client.setEncoding("utf8");
          client.on("data", (chunk) => { data += chunk; });
          client.once("error", reject);
          client.once("end", () => resolve(data));
        });
        assert.equal(reply, "ready");
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        sb.cleanup();
      }
    `], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        TMPDIR: base,
        // No build, installed manager, or daemon: the sandbox only needs a path.
        PI_FAMULUS_MANAGER_PATH: process.execPath,
        PI_FAMULUS_EVAL_KEEP: "",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
