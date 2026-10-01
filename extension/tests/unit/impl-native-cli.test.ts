import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import pkg from "../../package.json";

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
function consumer(native = true, exit = 0, nativeText?: string) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cli-test-")));
  const main = join(root, "node_modules", "pi-famulus");
  mkdirSync(join(main, "src"), { recursive: true });
  mkdirSync(join(main, "bin"));
  writeFileSync(join(main, "package.json"), JSON.stringify({ type: "module", version: pkg.version }));
  copyFileSync(new URL("../../src/native-manager.js", import.meta.url), join(main, "src", "native-manager.js"));
  copyFileSync(new URL("../../bin/pi-famulus.js", import.meta.url), join(main, "bin", "pi-famulus.js"));
  if (native) {
    const name = `pi-famulus-${process.platform}-${process.arch}`;
    const dir = join(root, "node_modules", name);
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: pkg.version,
      exports: { "./package.json": "./package.json", "./bin/pi-famulus": "./bin/pi-famulus" },
    }));
    const binary = join(dir, "bin", "pi-famulus");
    writeFileSync(binary, nativeText ?? `#!/bin/sh\nprintf '%s\\n' "$@"\nexit ${exit}\n`);
    chmodSync(binary, 0o755);
  }
  return join(main, "bin", "pi-famulus.js");
}

it("npm CLI forwards argument boundaries to the installed native executable", () => {
  const result = spawnSync(process.execPath, [consumer(), "output", "--", "one arg", ";echo injected"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("output\n--\none arg\n;echo injected\n");
  expect(result.stderr).toBe("");
});

it("npm CLI preserves native failure exit codes", () => {
  const result = spawnSync(process.execPath, [consumer(true, 42), "status"], { encoding: "utf8" });
  expect(result.status).toBe(42);
  expect(result.stdout).toBe("status\n");
});

it.each(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"])("preserves native termination by %s", (signal) => {
  const script = `#!/usr/bin/env node\nprocess.kill(process.pid, ${JSON.stringify(signal)});\n`;
  const result = spawnSync(process.execPath, [consumer(true, 0, script)], { encoding: "utf8" });
  expect(result.status).toBeNull();
  expect(result.signal).toBe(signal);
});

it("forwards supervisor SIGTERM to a long-running native command without leaving it alive", async () => {
  const script = '#!/usr/bin/env node\nprocess.on("SIGTERM", () => process.exit(23));\nconsole.log(process.pid);\nsetInterval(() => {}, 1000);\n';
  const child = spawn(process.execPath, [consumer(true, 0, script)], { stdio: ["ignore", "pipe", "pipe"] });
  let nativePid = 0;
  try {
    const [line] = await once(child.stdout!, "data");
    nativePid = Number(String(line).trim());
    expect(nativePid).toBeGreaterThan(0);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    expect(code).toBe(23);
    expect(signal).toBeNull();
    expect(() => process.kill(nativePid, 0)).toThrow();
  } finally {
    child.kill("SIGKILL");
    if (nativePid) try { process.kill(nativePid, "SIGKILL"); } catch { /* already gone */ }
  }
});

it("missing optional dependencies give an actionable error instead of trying another version", () => {
  const result = spawnSync(process.execPath, [consumer(false), "--version"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("optional dependencies enabled");
  expect(result.stderr).toContain("npm install --include=optional pi-famulus");
});
