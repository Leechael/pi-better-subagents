import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativePackageName, resolveNativeManagerPath } from "../../src/native-manager.js";
import pkg from "../../package.json";

describe("npm native manager selection", () => {
  it.each([
    ["linux", "x64", "pi-famulus-linux-x64"],
    ["linux", "arm64", "pi-famulus-linux-arm64"],
    ["darwin", "x64", "pi-famulus-darwin-x64"],
    ["darwin", "arm64", "pi-famulus-darwin-arm64"],
  ])("selects %s/%s", (platform, arch, name) => {
    expect(nativePackageName(platform, arch)).toBe(name);
  });

  it.each([["win32", "x64"], ["linux", "ia32"], ["freebsd", "arm64"]])(
    "does not invent an unsupported %s/%s package", (platform, arch) => {
      expect(nativePackageName(platform, arch)).toBeNull();
      expect(resolveNativeManagerPath({ platform, arch })).toBeNull();
    },
  );
});

describe("installed native manager", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function installed(version = pkg.version) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "native-test-")));
    const native = join(root, "node_modules", "pi-famulus-darwin-arm64");
    mkdirSync(join(native, "bin"), { recursive: true });
    writeFileSync(join(native, "package.json"), JSON.stringify({
      name: "pi-famulus-darwin-arm64", version,
      exports: { "./package.json": "./package.json", "./bin/pi-famulus": "./bin/pi-famulus" },
    }));
    const binary = join(native, "bin", "pi-famulus");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);
    return { binary, resolve: createRequire(join(root, "consumer.cjs")).resolve };
  }

  it("discovers the executable installed by the matching optional package", () => {
    const { binary, resolve } = installed();
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBe(binary);
  });

  it("rejects a non-executable native file rather than shadowing a working manual binary", () => {
    const { binary, resolve } = installed();
    chmodSync(binary, 0o644);
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBeNull();
  });

  it.each(["{", "null"])("ignores malformed native package metadata %s", (text) => {
    const { resolve } = installed();
    writeFileSync(join(root, "node_modules", "pi-famulus-darwin-arm64", "package.json"), text);
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBeNull();
  });

  it("never pairs the extension with a different native package version", () => {
    const { resolve } = installed("999.0.0");
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBeNull();
  });

  it.each(["missing", "directory"])("ignores a %s native executable", (kind) => {
    const { binary, resolve } = installed();
    rmSync(binary);
    if (kind === "directory") mkdirSync(binary);
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBeNull();
  });

  it("returns null when optional dependencies were omitted, permitting explicit/manual installs", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "native-test-")));
    const resolve = createRequire(join(root, "consumer.cjs")).resolve;
    expect(resolveNativeManagerPath({ platform: "darwin", arch: "arm64", resolve })).toBeNull();
  });
});
