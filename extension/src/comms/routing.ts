/**
 * Lineage checks (design doc §4.7): sibling messaging is only allowed inside
 * the same run. Pure functions over the CommsHost interface.
 */
import type { CommsHost } from "./types";

/**
 * Assert that child `fromChildId` may message child `toChildId`.
 * Throws Error("cross-run messaging not allowed") when the two children belong
 * to different runs (v1 lineage = same runId), and a clear error for self-send.
 */
export function assertSiblingAllowed(
  host: CommsHost,
  fromChildId: string,
  toChildId: string,
): void {
  if (fromChildId === toChildId) {
    throw new Error(`Child ${fromChildId} cannot send a message to itself.`);
  }
  if (!host.sameRun(fromChildId, toChildId)) {
    throw new Error("cross-run messaging not allowed");
  }
}
