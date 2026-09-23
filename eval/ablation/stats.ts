/** Wilson score interval, sequential stopping, and load-bearing verdicts. */

export function wilson(passes: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: Number.NaN, lo: 0, hi: 1 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export const LOAD_BEARING_DROP = 0.2;

export interface CellCounts {
  passes: number;
  n: number;
}

export type StopDecision = "continue" | "done" | "drop-certain" | "no-drop-certain" | "floor";

/**
 * Sequential early stopping for one (model, variant, scenario) cell.
 * - baseline cells run to k;
 * - variant cells wait for >= minN baseline samples, then stop as soon as the
 *   variant's Wilson interval lies entirely below (drop certain) or above
 *   (no drop certain) baseline - 20pp;
 * - "floor": baseline pass rate is certainly < 20%, so no leave-one-out on
 *   this (model, scenario) can drop it by 20pp: skip variants.
 */
export function stopDecision(
  cell: CellCounts,
  baseline: CellCounts | undefined,
  isBaseline: boolean,
  k: number,
  minN = 3,
): StopDecision {
  if (cell.n >= k) return "done";
  if (isBaseline) return "continue";
  if (!baseline || baseline.n < minN) return "continue";
  const b = wilson(baseline.passes, baseline.n);
  // A drop of 20pp is impossible below a 20% baseline (point rule once the
  // baseline is complete; interval rule while it is still sampling).
  if (b.hi < LOAD_BEARING_DROP || (baseline.n >= k && b.p < LOAD_BEARING_DROP)) return "floor";
  if (cell.n < minN) return "continue";
  const v = wilson(cell.passes, cell.n);
  const threshold = b.p - LOAD_BEARING_DROP;
  if (v.hi < threshold) return "drop-certain";
  if (v.lo > threshold) return "no-drop-certain";
  return "continue";
}

export type SegmentVerdict = "load-bearing" | "slop" | "untested";

/** Point-estimate rule from the spec: drop >= 20pp on any (model, scenario) → load-bearing. */
export function segmentVerdict(deltas: number[]): SegmentVerdict {
  if (deltas.length === 0) return "untested";
  return deltas.some((d) => d <= -LOAD_BEARING_DROP + 1e-9) ? "load-bearing" : "slop";
}
