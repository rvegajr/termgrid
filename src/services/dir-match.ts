/**
 * Directory path matching utilities for smart deep-link deduplication.
 * Normalizes both absolute and home-relative paths so they can be compared.
 */

/**
 * Normalize a directory path for comparison.
 * - Collapses /Users/x and /home/x to ~ to match prettified CWDs from pane-meta
 * - Strips trailing slashes (except root)
 * - Converts backslashes to forward slashes (Windows)
 */
export function normalizeDirPath(input: string): string {
  if (!input) return "";
  let p = input.trim().replace(/\\/g, "/");
  // collapse standard home dirs to ~ so absolute deep-link paths match prettified cwds
  p = p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  if (p.length > 1) p = p.replace(/\/+$/, ""); // strip trailing slash (not root)
  return p;
}

export interface PaneCwdEntry {
  paneId: string;
  cwd?: string;
}

/**
 * Find a pane ID whose current working directory matches the target path.
 * Returns the first match, or null if no pane has this directory open.
 */
export function findPaneIdByCwd(target: string, entries: PaneCwdEntry[]): string | null {
  const t = normalizeDirPath(target);
  if (!t) return null;
  for (const e of entries) {
    if (e.cwd && normalizeDirPath(e.cwd) === t) return e.paneId;
  }
  return null;
}
