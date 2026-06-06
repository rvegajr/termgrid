/**
 * Pure function to derive an auto tab name from pane meta.
 * Extracted for unit testing - the auto-naming logic is independent of SolidJS effects.
 */

export interface PaneMeta {
  cwd?: string;
  shell?: string;
}

/**
 * Derive a tab name from the first pane's metadata.
 * Returns null if the user has renamed the tab or if there's no useful metadata.
 */
export function deriveAutoTabName(
  meta: PaneMeta | null,
  currentName: string,
  tabNumber: number
): string | null {
  const defaultName = `Tab ${tabNumber}`;
  
  // If user renamed the tab (not the default name), don't override it
  if (currentName !== defaultName) {
    return null;
  }
  
  // No metadata yet
  if (!meta) {
    return null;
  }
  
  // Try cwd basename first
  if (meta.cwd) {
    const basename = meta.cwd.split('/').filter(Boolean).pop();
    if (basename && basename !== '~') {
      return basename;
    }
  }
  
  // Fall back to shell name
  if (meta.shell) {
    const shellBasename = meta.shell.split('/').pop();
    if (shellBasename) {
      return shellBasename;
    }
  }
  
  // No useful metadata
  return null;
}
