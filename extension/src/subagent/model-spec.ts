/**
 * Fuzzy model spec resolution (design doc §4.6 "模型解析", appendix B).
 *
 * Pure and pi-free: candidates are plain {provider, id, name} records so the
 * resolver is testable without a ModelRegistry. The caller decides the
 * candidate set (scopedModels whitelist when non-empty, else all available).
 *
 * Spec grammar: `[provider/|provider:]id[:thinking]`
 *   - thinking suffix: minimal|low|medium|high|xhigh (unrecognized suffixes
 *     are treated as part of the id, e.g. OpenRouter's ":exacto")
 *   - provider prefix: "provider/id" or "provider:id" both accepted
 *   - bare id: exact unique match, else case-insensitive substring on id/name
 */

export interface ModelCandidate {
  provider: string;
  id: string;
  name?: string;
}

export type ModelResolution =
  | { ok: true; provider: string; id: string; thinking?: string }
  | { ok: false; error: "no-match" | "ambiguous"; candidates: string[]; thinking?: string };

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function label(c: ModelCandidate): string {
  return `${c.provider}/${c.id}`;
}

/** Strip a trailing ":<thinking>" when it is a valid level. */
export function splitThinkingSuffix(spec: string): { base: string; thinking?: string } {
  const idx = spec.lastIndexOf(":");
  if (idx <= 0 || idx === spec.length - 1) return { base: spec };
  const suffix = spec.slice(idx + 1).toLowerCase();
  if (!THINKING_LEVELS.has(suffix)) return { base: spec };
  return { base: spec.slice(0, idx), thinking: suffix };
}

function splitProviderPrefix(spec: string): { provider: string; id: string } | null {
  // "provider/id" or "provider:id" — first separator wins; the remainder may
  // itself contain separators (model ids with colons, e.g. ":exacto").
  for (const sep of ["/", ":"]) {
    const idx = spec.indexOf(sep);
    if (idx > 0 && idx < spec.length - 1) {
      return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
    }
  }
  return null;
}

export function resolveModelSpec(spec: string, candidates: ModelCandidate[]): ModelResolution {
  const { base, thinking } = splitThinkingSuffix(spec.trim());
  if (base.length === 0) {
    return { ok: false, error: "no-match", candidates: candidates.map(label), thinking };
  }

  // 1) provider-qualified exact match
  const qualified = splitProviderPrefix(base);
  if (qualified) {
    const hit = candidates.find(
      (c) => c.provider === qualified.provider && c.id === qualified.id,
    );
    if (hit) return { ok: true, provider: hit.provider, id: hit.id, thinking };
    // Fall through: maybe the whole thing is a bare id containing a separator.
  }

  // 2) bare-id exact match (must be unique across providers)
  const exact = candidates.filter((c) => c.id === base);
  if (exact.length === 1) {
    return { ok: true, provider: exact[0].provider, id: exact[0].id, thinking };
  }
  if (exact.length > 1) {
    return { ok: false, error: "ambiguous", candidates: exact.map(label), thinking };
  }

  // 3) case-insensitive substring on id or display name
  const needle = base.toLowerCase();
  const fuzzy = candidates.filter(
    (c) =>
      c.id.toLowerCase().includes(needle) ||
      (c.name !== undefined && c.name.toLowerCase().includes(needle)),
  );
  if (fuzzy.length === 1) {
    return { ok: true, provider: fuzzy[0].provider, id: fuzzy[0].id, thinking };
  }
  if (fuzzy.length > 1) {
    return { ok: false, error: "ambiguous", candidates: fuzzy.map(label), thinking };
  }
  return { ok: false, error: "no-match", candidates: candidates.map(label), thinking };
}

/** Render a resolution failure as an actionable error message. */
export function modelResolutionError(spec: string, res: ModelResolution & { ok: false }): string {
  const list = res.candidates.slice(0, 20).join(", ");
  const more = res.candidates.length > 20 ? `, … +${res.candidates.length - 20} more` : "";
  if (res.error === "ambiguous") {
    return (
      `model spec "${spec}" is ambiguous (matches: ${list}${more}). ` +
      `Qualify with "provider/<id>".`
    );
  }
  return (
    `model spec "${spec}" matched nothing. ` +
    `Available: ${list || "none"}${more}. ` +
    `Use subagent({action:"models"}) to list selectable models.`
  );
}
