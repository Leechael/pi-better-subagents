/**
 * Extension configuration loading (design doc §4.9).
 *
 * Config file: <pbs-home>/config.json
 * Base directory resolution: PBS_HOME env > ~/.pi/agent/pbs
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface PbsConfig {
  /** Foreground budget for bash before auto-backgrounding (ms). */
  foregroundBudgetMs: number;
  /** Foreground budget for subagent runs (ms). Reserved for M3. */
  subagentBudgetMs: number;
  /** Explicit path to the pbs-manager binary, or null for auto-resolution. */
  managerPath: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Optional M3 subagent tuning section (design doc §4.6 limits). */
  subagent?: PbsSubagentConfig;
}

/** Optional `subagent` section of config.json; every field defaults (see resolveSubagentConfig). */
export interface PbsSubagentConfig {
  /** Sync-wait budget before a run is moved to background (ms). Overrides top-level subagentBudgetMs. */
  budgetMs?: number;
  /** Default per-child hard timeout (ms). */
  timeoutMs?: number;
  /** Stall watchdog: abort a child with no events for this long (ms). */
  stallMs?: number;
  /** Default per-run worker pool concurrency. */
  concurrency?: number;
  /** Global cap on concurrently running children across all runs. */
  maxConcurrentChildren?: number;
  /** Max child sessions spawned per hour. */
  spawnBudgetPerHour?: number;
}

/** Subagent settings with every field resolved (design doc §4.6 defaults). */
export interface ResolvedSubagentConfig {
  budgetMs: number;
  timeoutMs: number;
  stallMs: number;
  concurrency: number;
  maxConcurrentChildren: number;
  spawnBudgetPerHour: number;
}

export const DEFAULT_SUBAGENT_CONFIG: ResolvedSubagentConfig = {
  budgetMs: 45000,
  timeoutMs: 600000,
  stallMs: 600000,
  concurrency: 4,
  maxConcurrentChildren: 8,
  spawnBudgetPerHour: 32,
};

/** Merge defaults <- top-level subagentBudgetMs <- subagent section. */
export function resolveSubagentConfig(config: PbsConfig): ResolvedSubagentConfig {
  const section = config.subagent ?? {};
  const resolved = { ...DEFAULT_SUBAGENT_CONFIG };
  resolved.budgetMs = config.subagentBudgetMs > 0 ? config.subagentBudgetMs : resolved.budgetMs;
  if (typeof section.budgetMs === "number" && section.budgetMs > 0) resolved.budgetMs = section.budgetMs;
  if (typeof section.timeoutMs === "number" && section.timeoutMs > 0) resolved.timeoutMs = section.timeoutMs;
  if (typeof section.stallMs === "number" && section.stallMs > 0) resolved.stallMs = section.stallMs;
  if (typeof section.concurrency === "number" && section.concurrency >= 1) {
    resolved.concurrency = Math.floor(section.concurrency);
  }
  if (typeof section.maxConcurrentChildren === "number" && section.maxConcurrentChildren >= 1) {
    resolved.maxConcurrentChildren = Math.floor(section.maxConcurrentChildren);
  }
  if (typeof section.spawnBudgetPerHour === "number" && section.spawnBudgetPerHour >= 1) {
    resolved.spawnBudgetPerHour = Math.floor(section.spawnBudgetPerHour);
  }
  return resolved;
}

export const DEFAULT_CONFIG: PbsConfig = {
  foregroundBudgetMs: 20000,
  subagentBudgetMs: 45000,
  managerPath: null,
  logLevel: "info",
};

/** Resolve the pbs base directory. PBS_HOME overrides the default. */
export function getPbsHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PBS_HOME;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".pi", "agent", "pbs");
}

/** Well-known paths inside the pbs home directory (design doc §3.1). */
export function pbsPaths(home: string) {
  return {
    home,
    socket: join(home, "manager.sock"),
    pidFile: join(home, "manager.pid"),
    spawnLock: join(home, "manager.spawn.lock"),
    log: join(home, "manager.log"),
    config: join(home, "config.json"),
    sessionsDir: join(home, "sessions"),
  };
}

/** Full-output file path for a task (design doc §3.1 layout). */
export function taskOutputPath(home: string, sessionId: string, taskId: string): string {
  return join(home, "sessions", sessionId, "tasks", `${taskId}.output`);
}

/** Load config.json, tolerating missing/malformed files and unknown fields. */
export function loadConfig(home: string = getPbsHome()): PbsConfig {
  const path = pbsPaths(home).config;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const obj = raw as Record<string, unknown>;
  const config = { ...DEFAULT_CONFIG };
  if (typeof obj.foregroundBudgetMs === "number" && obj.foregroundBudgetMs > 0) {
    config.foregroundBudgetMs = obj.foregroundBudgetMs;
  }
  if (typeof obj.subagentBudgetMs === "number" && obj.subagentBudgetMs > 0) {
    config.subagentBudgetMs = obj.subagentBudgetMs;
  }
  if (typeof obj.managerPath === "string" && obj.managerPath.length > 0) {
    config.managerPath = obj.managerPath;
  }
  if (
    obj.logLevel === "debug" ||
    obj.logLevel === "info" ||
    obj.logLevel === "warn" ||
    obj.logLevel === "error"
  ) {
    config.logLevel = obj.logLevel;
  }
  if (typeof obj.subagent === "object" && obj.subagent !== null) {
    const section = obj.subagent as Record<string, unknown>;
    const subagent: PbsSubagentConfig = {};
    if (typeof section.budgetMs === "number" && section.budgetMs > 0) subagent.budgetMs = section.budgetMs;
    if (typeof section.timeoutMs === "number" && section.timeoutMs > 0) subagent.timeoutMs = section.timeoutMs;
    if (typeof section.stallMs === "number" && section.stallMs > 0) subagent.stallMs = section.stallMs;
    if (typeof section.concurrency === "number" && section.concurrency >= 1) {
      subagent.concurrency = section.concurrency;
    }
    if (typeof section.maxConcurrentChildren === "number" && section.maxConcurrentChildren >= 1) {
      subagent.maxConcurrentChildren = section.maxConcurrentChildren;
    }
    if (typeof section.spawnBudgetPerHour === "number" && section.spawnBudgetPerHour >= 1) {
      subagent.spawnBudgetPerHour = section.spawnBudgetPerHour;
    }
    config.subagent = subagent;
  }
  return config;
}

/**
 * Resolve the pbs-manager binary path.
 * Priority: config.managerPath > PBS_MANAGER_PATH env > <home>/bin/pbs-manager > PATH.
 * Returns null when no candidate exists.
 */
export function resolveManagerPath(
  config: PbsConfig,
  home: string = getPbsHome(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.managerPath && existsSync(config.managerPath)) return config.managerPath;
  const envPath = env.PBS_MANAGER_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const bundled = join(home, "bin", "pbs-manager");
  if (existsSync(bundled)) return bundled;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "pbs-manager");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}
