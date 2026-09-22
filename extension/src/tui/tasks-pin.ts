/** Subagents whose detail view is open — kept in /tasks until the view closes. */
const pinned = new Set<string>();

export function pinSubagent(childId: string): void {
  pinned.add(childId);
}

export function unpinSubagent(childId: string): void {
  pinned.delete(childId);
}

export function isSubagentPinned(childId: string): boolean {
  return pinned.has(childId);
}

export function clearPinnedSubagents(): void {
  pinned.clear();
}
