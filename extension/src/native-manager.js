import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const resolveInstalled = createRequire(import.meta.url).resolve;

/** The four native optional packages are selected by npm's os/cpu constraints. */
export function nativePackageName(platform, arch) {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  return `pi-famulus-${platform}-${arch}`;
}

/** Resolve the exact-version optional package without loading native executable bytes. */
export function resolveNativeManagerPath({ platform = process.platform, arch = process.arch, resolve = resolveInstalled } = {}) {
  const name = nativePackageName(platform, arch);
  if (!name) return null;
  try {
    const metadata = JSON.parse(readFileSync(resolve(`${name}/package.json`), "utf8"));
    if (!metadata || metadata.name !== name || metadata.version !== packageVersion) return null;
    const binary = resolve(`${name}/bin/pi-famulus`);
    if (!statSync(binary).isFile()) return null;
    accessSync(binary, constants.X_OK);
    return binary;
  } catch (error) {
    if (error instanceof SyntaxError || [
      "MODULE_NOT_FOUND", "ENOENT", "ENOTDIR", "EACCES", "EPERM",
      "ERR_INVALID_PACKAGE_CONFIG", "ERR_PACKAGE_PATH_NOT_EXPORTED",
    ].includes(error.code)) return null;
    throw error;
  }
}
