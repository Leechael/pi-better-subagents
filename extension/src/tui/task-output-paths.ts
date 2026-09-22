import { statSync } from "node:fs";
import { readFileTail } from "../file-tail";

/** Sibling stderr file next to `<id>.output` (matches pbs-manager). */
export function stderrPathFor(outputPath: string): string {
  if (!outputPath) return "";
  const dot = outputPath.lastIndexOf(".");
  if (dot > 0) return `${outputPath.slice(0, dot)}.stderr`;
  return `${outputPath}.stderr`;
}

const tailCache = new Map<string, { size: number; mtimeMs: number; text: string }>();

export function readTaskFileTail(path: string, maxBytes = 512_000): string {
  if (!path) return "(no output path)";
  const tail = readFileTail(path, maxBytes);
  if (!tail) return "(empty)";
  if (tail.size === 0) return "(empty)";
  if (tail.size <= maxBytes) return tail.text;
  return `… (${tail.size} bytes total, showing last ${maxBytes})\n${tail.text}`;
}

/**
 * Tail read cached by size+mtime. Callers should only ask for the tab they are showing.
 */
export function readTaskFileTailCached(path: string, maxBytes = 512_000): string {
  if (!path) return "(no output path)";
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return readTaskFileTail(path, maxBytes);
  }
  const hit = tailCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.text;
  const text = readTaskFileTail(path, maxBytes);
  tailCache.set(path, { size, mtimeMs, text });
  return text;
}

export function clearTaskFileTailCache(): void {
  tailCache.clear();
}
