/**
 * Service for tracking recently used working directories.
 * Maintains a 20-entry ring buffer of recent CWDs across all panes.
 */

import * as machineCache from "./machine-cache";

export interface RecentCwd {
  path: string;
  lastUsedAt: number;
}

const CACHE_KEY = "recentCwds";
const MAX_RECENT = 20;

/**
 * Get all recent CWDs, sorted by most recent first.
 */
export async function getRecentCwds(): Promise<RecentCwd[]> {
  const cwds = await machineCache.get<RecentCwd[]>(CACHE_KEY);
  return cwds ?? [];
}

/**
 * Record a CWD as recently used.
 * If already present, updates its timestamp and moves to front.
 */
export async function recordCwd(path: string): Promise<void> {
  if (!path) return;
  
  const cwds = await getRecentCwds();
  
  // Remove existing entry if present
  const filtered = cwds.filter((c) => c.path !== path);
  
  // Add new entry at the front
  const newEntry: RecentCwd = {
    path,
    lastUsedAt: Date.now(),
  };
  
  filtered.unshift(newEntry);
  
  // Keep only MAX_RECENT entries
  const trimmed = filtered.slice(0, MAX_RECENT);
  
  await machineCache.set(CACHE_KEY, trimmed);
}

/**
 * Get the top N most recent CWDs for display.
 */
export async function getTopRecentCwds(count: number): Promise<RecentCwd[]> {
  const cwds = await getRecentCwds();
  return cwds.slice(0, count);
}

/**
 * Get the basename of a path (last component).
 */
export function pathBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}
