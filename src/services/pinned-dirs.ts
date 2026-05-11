/**
 * Service for managing pinned directory quick links.
 * Allows users to pin frequently-used directories for quick navigation.
 */

import * as machineCache from "./machine-cache";

export interface PinnedDir {
  path: string;
  label?: string; // Optional custom label, defaults to basename
  pinnedAt: number;
}

const CACHE_KEY = "pinnedDirs";
const MAX_PINNED = 10;

/**
 * Get all pinned directories, sorted by pin time (newest first).
 */
export async function getPinnedDirs(): Promise<PinnedDir[]> {
  const dirs = await machineCache.get<PinnedDir[]>(CACHE_KEY);
  return dirs ?? [];
}

/**
 * Pin a directory. If already pinned, updates the pinnedAt timestamp.
 */
export async function pinDir(path: string, label?: string): Promise<void> {
  const dirs = await getPinnedDirs();
  
  // Remove existing entry if present
  const filtered = dirs.filter((d) => d.path !== path);
  
  // Add new entry at the front
  const newEntry: PinnedDir = {
    path,
    label,
    pinnedAt: Date.now(),
  };
  
  filtered.unshift(newEntry);
  
  // Keep only MAX_PINNED entries
  const trimmed = filtered.slice(0, MAX_PINNED);
  
  await machineCache.set(CACHE_KEY, trimmed);
}

/**
 * Unpin a directory by path.
 */
export async function unpinDir(path: string): Promise<void> {
  const dirs = await getPinnedDirs();
  const filtered = dirs.filter((d) => d.path !== path);
  await machineCache.set(CACHE_KEY, filtered);
}

/**
 * Check if a directory is currently pinned.
 */
export async function isPinned(path: string): Promise<boolean> {
  const dirs = await getPinnedDirs();
  return dirs.some((d) => d.path === path);
}

/**
 * Get the basename of a path (last component).
 */
export function pathBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}
