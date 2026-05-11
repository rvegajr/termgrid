/**
 * Most Recently Used (MRU) shell tracking.
 * 
 * Remembers which shell the user launched last and hoists it to
 * the top of the welcome screen for quick access.
 */

import * as machineCache from "./machine-cache";

interface MruShellEntry {
  path: string;
  lastUsedAt: number;
}

const CACHE_KEY = "mruShell";

/**
 * Load the most recently used shell from cache.
 */
export async function getMruShell(): Promise<MruShellEntry | null> {
  return (await machineCache.get<MruShellEntry>(CACHE_KEY)) ?? null;
}

/**
 * Record that a shell was just used.
 */
export async function recordShellUse(shellPath: string): Promise<void> {
  const entry: MruShellEntry = {
    path: shellPath,
    lastUsedAt: Date.now(),
  };
  await machineCache.set(CACHE_KEY, entry);
}
