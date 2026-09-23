/**
 * Segment manifest: loading, variant expansion, and the text-removal engine.
 * Imported both by the runner (node) and by harness/ablation-ext.ts (inside
 * pi), so it must stay dependency-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as guidelines from "../../extension/src/behavior-guidelines.ts";
import * as wake from "../../extension/src/wake.ts";

/** Extension exports a segment may take its text from (`textFrom: "wake.PBS_WAKE_LEAD_IN"`). */
const TEXT_SOURCES: Record<string, Record<string, unknown>> = { wake, guidelines };

function resolveTextFrom(ref: string): string {
  const [mod, name] = ref.split(".");
  const value = TEXT_SOURCES[mod]?.[name];
  if (typeof value !== "string") throw new Error(`manifest textFrom "${ref}" does not name a string export`);
  return value;
}

export interface Segment {
  id: string;
  kind: "text" | "regex" | "hook" | "config";
  surface: string;
  text?: string;
  /** Read the text from an extension export instead of copying it. */
  textFrom?: string;
  pattern?: string;
  pbsConfig?: Record<string, unknown>;
  /** "child": only child sessions see it. */
  scope?: "parent" | "child";
  /** false: no external hook can remove it (see notAblatableExternally). Never scheduled as a variant. */
  ablatable?: boolean;
  /** Scenario ids expected to be affected; "*" = all (controls). */
  affects: string[];
  control?: boolean;
}

export const isAblatable = (s: Segment) => s.ablatable !== false;

export interface Group {
  id: string;
  segments: string[];
}

export interface Manifest {
  version: number;
  segments: Segment[];
  groups: Group[];
}

export const MANIFEST_PATH = join(import.meta.dirname, "manifest.json");

export function loadManifest(path = MANIFEST_PATH): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  for (const s of m.segments) if (s.textFrom) s.text = resolveTextFrom(s.textFrom);
  return m;
}

/** A variant = named set of removed segments. "baseline" removes nothing. */
export interface Variant {
  id: string;
  segments: Segment[];
}

export function resolveVariant(m: Manifest, id: string): Variant {
  if (id === "baseline") return { id, segments: [] };
  const seg = m.segments.find((s) => s.id === id);
  if (seg && seg.ablatable === false) throw new Error(`segment ${id} cannot be ablated externally (see notAblatableExternally)`);
  if (seg) return { id, segments: [seg] };
  const group = m.groups.find((g) => g.id === id);
  if (group) {
    return {
      id,
      segments: group.segments.map((sid) => {
        const s = m.segments.find((x) => x.id === sid);
        if (!s) throw new Error(`group ${id} references unknown segment ${sid}`);
        return s;
      }),
    };
  }
  throw new Error(`unknown variant "${id}" (baseline, a segment id, or a group id)`);
}

/** Comma-separated union of variants (used by the harness self-test). */
export function resolveVariantList(m: Manifest, ids: string): Variant {
  const parts = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return resolveVariant(m, parts[0] ?? "baseline");
  const segments = new Map<string, Segment>();
  for (const p of parts) for (const s of resolveVariant(m, p).segments) segments.set(s.id, s);
  return { id: ids, segments: [...segments.values()] };
}

/** Does this variant plausibly affect the scenario (per manifest `affects`)? */
export function variantAffects(v: Variant, scenarioId: string): boolean {
  if (v.id === "baseline") return true;
  return v.segments.some((s) => s.affects.includes("*") || s.affects.includes(scenarioId));
}

/** Merge config-kind mechanisms into the sandbox pbs config. */
export function variantPbsConfig(v: Variant): Record<string, unknown> {
  return Object.assign({}, ...v.segments.filter((s) => s.kind === "config").map((s) => s.pbsConfig ?? {}));
}

// ---------------------------------------------------------------------------
// Removal engine
// ---------------------------------------------------------------------------

export interface CompiledSegment {
  id: string;
  re: RegExp;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileTextSegments(segments: Segment[]): CompiledSegment[] {
  return segments.flatMap((s) => {
    if (s.kind === "text" && s.text) return [{ id: s.id, re: new RegExp(escapeRe(s.text), "g") }];
    if (s.kind === "regex" && s.pattern) return [{ id: s.id, re: new RegExp(s.pattern, "g") }];
    return [];
  });
}

/** Remove all segments from one string; counts hits per segment id. */
export function removeSegments(input: string, segs: CompiledSegment[], hits: Map<string, number>): string {
  let out = input;
  let changed = false;
  for (const seg of segs) {
    seg.re.lastIndex = 0;
    const n = out.match(seg.re)?.length ?? 0;
    if (n === 0) continue;
    out = out.replace(seg.re, "");
    hits.set(seg.id, (hits.get(seg.id) ?? 0) + n);
    changed = true;
  }
  if (!changed) return input;
  // Drop bullets left empty and collapse the blank lines a removal leaves.
  return out.replace(/^[ \t]*- *$\n?/gm, "").replace(/\n{3,}/g, "\n\n");
}

/** Deep-walk a JSON-ish value, removing segments from every string. */
export function removeDeep<T>(value: T, segs: CompiledSegment[], hits: Map<string, number>): T {
  if (typeof value === "string") return removeSegments(value, segs, hits) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = removeDeep(v, segs, hits);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = removeDeep(v, segs, hits);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/** Same patterns as extension/src/bash-override.ts BARE_SLEEP_PATTERNS. */
export const BARE_SLEEP_PATTERNS: RegExp[] = [/^\s*sleep\s+\d/, /^\s*while\s+true\b/, /^\s*while\s+sleep\b/, /^\s*until\s+/];
