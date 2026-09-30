import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, describeManagerSearch, getFamulusHome, famulusPaths, resolveManagerPath } from "../../src/config";

describe("degraded-startup manager search description", () => {
  it("names every place looked and flags configured paths that do not exist", () => {
    const text = describeManagerSearch(
      { managerPath: "/nope/pi-famulus" } as never,
      "/home/u/.pi/agent/pi-famulus",
      { PI_FAMULUS_MANAGER_PATH: "/also/missing" },
    );
    expect(text).toContain("config managerPath /nope/pi-famulus (missing, ignored)");
    expect(text).toContain("PI_FAMULUS_MANAGER_PATH /also/missing (missing, ignored)");
    expect(text).toContain("/home/u/.pi/agent/pi-famulus/bin/pi-famulus");
    expect(text).toContain("pi-famulus on PATH");
  });
});

describe("Famulus home and binary lookup", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("uses the new default home and environment override", () => {
    const expected = join(homedir(), ".pi", "agent", "pi-famulus");
    expect(getFamulusHome({})).toBe(expected);
    expect(getFamulusHome({ PI_FAMULUS_HOME: "   " })).toBe(expected);
    expect(getFamulusHome({ PI_FAMULUS_HOME: "/custom/famulus" })).toBe("/custom/famulus");
    expect(famulusPaths(expected)).toMatchObject({
      socket: join(expected, "manager.sock"),
      pidFile: join(expected, "manager.pid"),
      spawnLock: join(expected, "manager.spawn.lock"),
      log: join(expected, "manager.log"),
    });
  });

  it("looks up pi-famulus in config, env, home/bin, then executable PATH order", () => {
    root = mkdtempSync(join(tmpdir(), "pi-famulus-search-"));
    const home = join(root, "home");
    const pathDir = join(root, "path");
    const bundled = join(home, "bin", "pi-famulus");
    const onPath = join(pathDir, "pi-famulus");
    const envBinary = join(root, "env-binary");
    const configured = join(root, "configured-binary");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(pathDir);
    for (const path of [bundled, onPath, envBinary, configured]) writeFileSync(path, "");
    chmodSync(onPath, 0o755);
    const env = { PI_FAMULUS_MANAGER_PATH: envBinary, PATH: pathDir };
    expect(resolveManagerPath({ ...DEFAULT_CONFIG, managerPath: configured }, home, env)).toBe(configured);
    expect(resolveManagerPath(DEFAULT_CONFIG, home, env)).toBe(envBinary);
    expect(resolveManagerPath(DEFAULT_CONFIG, home, { ...env, PI_FAMULUS_MANAGER_PATH: "/missing" })).toBe(bundled);
    rmSync(bundled);
    expect(resolveManagerPath(DEFAULT_CONFIG, home, { PATH: pathDir })).toBe(onPath);
    chmodSync(onPath, 0o644);
    expect(resolveManagerPath(DEFAULT_CONFIG, home, { PATH: pathDir })).toBeNull();
  });
});
