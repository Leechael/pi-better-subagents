/**
 * Model metadata (for cost estimates) straight from pi: we never read
 * auth.json or keys ourselves. `get_available_models` over RPC returns only
 * models pi can authenticate, with list prices per million tokens.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpc } from "./rpc.ts";

export interface ModelInfo {
  provider: string;
  id: string;
  /** $ per 1M tokens */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelSpec {
  spec: string;
  provider: string;
  id: string;
  thinking?: string;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseModelSpec(spec: string): ModelSpec {
  let body = spec;
  let thinking: string | undefined;
  const colon = spec.lastIndexOf(":");
  if (colon > 0 && THINKING.has(spec.slice(colon + 1))) {
    thinking = spec.slice(colon + 1);
    body = spec.slice(0, colon);
  }
  const slash = body.indexOf("/");
  if (slash < 0) throw new Error(`model spec must be provider/id[:thinking]: ${spec}`);
  return { spec, provider: body.slice(0, slash), id: body.slice(slash + 1), ...(thinking ? { thinking } : {}) };
}

/** Authenticated models as pi sees them with the eval's flags (-ne etc.). */
export async function availableModels(): Promise<ModelInfo[]> {
  const cwd = mkdtempSync(join(tmpdir(), "pbse-models-"));
  // Any authenticated model works for starting RPC; model selection is not used.
  const pi = new PiRpc({ cwd, env: {}, model: process.env.PBS_EVAL_PROBE_MODEL ?? "", extraArgs: [] });
  try {
    const res = await Promise.race([
      pi.send({ type: "get_available_models" }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("get_available_models timed out")), 30_000)),
    ]);
    const data = res.data as { models?: ModelInfo[] } | ModelInfo[] | undefined;
    const models = Array.isArray(data) ? data : (data?.models ?? []);
    return models.map((m) => ({ provider: m.provider, id: m.id, cost: m.cost }));
  } finally {
    await pi.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}
