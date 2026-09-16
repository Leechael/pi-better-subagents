/**
 * Agent definition loading and caching (design doc §4.8, appendix B).
 *
 * Three-tier merge, later layers win by name:
 *   builtin < userDir (**\/*.md) < projectDir (**\/*.md)
 *
 * Pure module: node:fs/node:path only. Missing directories are an empty set,
 * not an error. Unparseable files are collected into LoadReport.errors and
 * never abort the load.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_AGENTS } from "./builtins";
import { parseAgentMarkdown, type AgentDefinition } from "./definition";

export interface LoadReport {
  definitions: AgentDefinition[];
  errors: { path: string; error: string }[];
}

export interface LoadAgentDefinitionsOptions {
  userDir: string;
  projectDir: string;
}

/** Recursively list *.md files under dir (sorted; missing dir → []). */
function scanMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** One-shot load: scan both dirs, parse everything, merge three tiers. */
export function loadAgentDefinitions(opts: LoadAgentDefinitionsOptions): LoadReport {
  const merged = new Map<string, AgentDefinition>();
  const errors: { path: string; error: string }[] = [];

  for (const def of BUILTIN_AGENTS) {
    merged.set(def.name, def);
  }

  const layers: { dir: string; source: "user" | "project" }[] = [
    { dir: opts.userDir, source: "user" },
    { dir: opts.projectDir, source: "project" },
  ];
  for (const { dir, source } of layers) {
    for (const path of scanMarkdownFiles(dir)) {
      try {
        const def = parseAgentMarkdown(readFileSync(path, "utf8"), source, path);
        merged.set(def.name, def);
      } catch (err) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { definitions: [...merged.values()], errors };
}

export interface AgentLoader {
  /**
   * Return the current definitions. Re-parses only when the set of markdown
   * files or any file's mtime has changed since the last call; otherwise
   * returns the identical LoadReport object.
   */
  reload(): LoadReport;
}

/**
 * Create a loader with an mtime fingerprint cache. The fingerprint covers the
 * sorted file list plus each file's mtime, so added/removed/modified files all
 * trigger a re-parse while an unchanged tree costs only a directory scan.
 */
export function createAgentLoader(opts: LoadAgentDefinitionsOptions): AgentLoader {
  let cached: LoadReport | null = null;
  let fingerprint: string | null = null;

  function computeFingerprint(): string {
    const parts: string[] = [];
    for (const dir of [opts.userDir, opts.projectDir]) {
      for (const path of scanMarkdownFiles(dir)) {
        let mtime = "?";
        try {
          mtime = String(statSync(path).mtimeMs);
        } catch {
          // Unstatable file: keep "?" so the fingerprint differs from any
          // previous numeric mtime and the load below records the error.
        }
        parts.push(`${path}:${mtime}`);
      }
    }
    return parts.join("\n");
  }

  return {
    reload(): LoadReport {
      const fp = computeFingerprint();
      if (cached !== null && fp === fingerprint) {
        return cached;
      }
      cached = loadAgentDefinitions(opts);
      fingerprint = fp;
      return cached;
    },
  };
}
