import { existsSync, readFileSync, statSync } from "node:fs";

/** Sibling stderr file next to `<id>.output` (matches pbs-manager). */
export function stderrPathFor(outputPath: string): string {
  if (!outputPath) return "";
  const dot = outputPath.lastIndexOf(".");
  if (dot > 0) return `${outputPath.slice(0, dot)}.stderr`;
  return `${outputPath}.stderr`;
}

export function readTaskFileTail(path: string, maxBytes = 512_000): string {
  if (!path) return "(no output path)";
  if (!existsSync(path)) return "(empty)";
  try {
    const size = statSync(path).size;
    if (size === 0) return "(empty)";
    const buf = readFileSync(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return `… (${size} bytes total, showing last ${maxBytes})\n${buf.subarray(buf.length - maxBytes).toString("utf8")}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
