/**
 * Helper for marking panes as exited in a Set.
 * Extracted for unit testing - keeps the core logic pure and testable.
 */

export function markPaneExited(
  exitedSet: Set<string>,
  paneId: string
): Set<string> {
  const newSet = new Set(exitedSet);
  newSet.add(paneId);
  return newSet;
}

export function isPaneExited(exitedSet: Set<string>, paneId: string): boolean {
  return exitedSet.has(paneId);
}
