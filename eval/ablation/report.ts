/**
 * Aggregate results.jsonl: pass rate per (model, variant, scenario) with a
 * 95% Wilson CI, delta vs. baseline, and per-segment verdicts:
 *   load-bearing — removing it drops the pass rate by >= 20pp on some (model, scenario)
 *   slop         — tested somewhere and never load-bearing
 *   untested     — no scored cell (not in any `affects`, or floor/no baseline)
 *
 *   node ablation/report.ts [--results FILE] [--out report.md]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadManifest } from "./manifest.ts";
import { DEFAULT_RESULTS, loadResults, type ResultRecord } from "./run.ts";
import { LOAD_BEARING_DROP, segmentVerdict, wilson } from "./stats.ts";

export function buildReport(records: ResultRecord[]): string {
  const manifest = loadManifest();
  const scoredRecs = records.filter((r) => r.pass !== null && !r.error);
  const group = new Map<string, ResultRecord[]>();
  for (const r of scoredRecs) {
    const key = `${r.model}|${r.variant}|${r.scenario}`;
    group.set(key, [...(group.get(key) ?? []), r]);
  }
  const rate = (key: string) => {
    const rs = group.get(key) ?? [];
    const passes = rs.filter((r) => r.pass).length;
    return { n: rs.length, passes, ...wilson(passes, rs.length), vacuous: rs.filter((r) => r.ablationMisses.length > 0).length };
  };
  const fmt = (x: { n: number; passes: number; p: number; lo: number; hi: number }) =>
    x.n === 0 ? "—" : `${Math.round(x.p * 100)}% (${x.passes}/${x.n}) [${Math.round(x.lo * 100)}–${Math.round(x.hi * 100)}]`;

  const models = [...new Set(scoredRecs.map((r) => r.model))];
  const scenarios = [...new Set(scoredRecs.map((r) => r.scenario))];
  const variants = [...new Set(scoredRecs.map((r) => r.variant))].sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : a.localeCompare(b)));

  const out: string[] = ["# Ablation report", ""];
  const invalid = records.filter((r) => r.pass === null && !r.error).length;
  const errors = records.filter((r) => r.error).length;
  const cost = records.reduce((a, r) => a + (r.usage?.cost ?? 0), 0);
  out.push(`episodes: ${records.length} (scored ${scoredRecs.length}, invalid ${invalid}, errors ${errors}); parent-session cost reported by pi: $${cost.toFixed(3)}`, "");

  const deltasBySegment = new Map<string, Array<{ d: number; model: string; scenario: string }>>();
  for (const model of models) {
    out.push(`## ${model}`, "", `| variant | ${scenarios.join(" | ")} |`, `|---|${scenarios.map(() => "---").join("|")}|`);
    for (const variant of variants) {
      const cells = scenarios.map((s) => {
        const v = rate(`${model}|${variant}|${s}`);
        if (v.n === 0) return "—";
        if (variant === "baseline") return fmt(v);
        const b = rate(`${model}|baseline|${s}`);
        if (b.n === 0) return `${fmt(v)} (no baseline)`;
        const d = v.p - b.p;
        const ids = manifest.groups.find((g) => g.id === variant)?.segments ?? [variant];
        if (ids.length === 1) deltasBySegment.set(variant, [...(deltasBySegment.get(variant) ?? []), { d, model, scenario: s }]);
        const flag = d <= -LOAD_BEARING_DROP + 1e-9 ? " **▼**" : "";
        const vac = v.vacuous ? ` (${v.vacuous} vacuous)` : "";
        return `${fmt(v)} Δ${d >= 0 ? "+" : ""}${Math.round(d * 100)}pp${flag}${vac}`;
      });
      out.push(`| ${variant} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }

  out.push("## Segment verdicts", "", "| segment | verdict | worst Δ (model / scenario) | surface |", "|---|---|---|---|");
  for (const seg of manifest.segments) {
    const ds = deltasBySegment.get(seg.id) ?? [];
    const verdict = seg.ablatable === false ? "not ablatable" : segmentVerdict(ds.map((x) => x.d));
    const worst = ds.sort((a, b) => a.d - b.d)[0];
    const control = seg.control ? " (control)" : "";
    const alarm = seg.control && verdict === "load-bearing" ? " ⚠ control came out load-bearing: results are noise" : "";
    out.push(
      `| ${seg.id}${control} | ${verdict}${alarm} | ${worst ? `${Math.round(worst.d * 100)}pp (${worst.model} / ${worst.scenario})` : "—"} | ${seg.surface} |`,
    );
  }
  out.push(
    "",
    "Δ = variant pass rate − baseline pass rate (point estimates). ▼ = drop ≥ 20pp. Brackets: 95% Wilson CI. " +
      "'vacuous' = the removed text never appeared in that episode (surface not reached), so the episode equals baseline.",
  );
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { results: { type: "string", default: DEFAULT_RESULTS }, out: { type: "string" } } });
  const report = buildReport(loadResults(values.results));
  if (values.out) writeFileSync(values.out, `${report}\n`);
  console.log(report);
}
