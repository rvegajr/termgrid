/**
 * Service for managing custom shell profiles.
 * Profiles define shell with optional CWD and commands to run on startup.
 */

import * as machineCache from "./machine-cache";

export interface ShellProfile {
  id: string;
  name: string;
  shell: string;
  cwd?: string;
  commands: string[];
  createdAt: number;
}

const CACHE_KEY = "shellProfiles";
const MAX_PROFILES = 30;

/**
 * Get all shell profiles.
 */
export async function getProfiles(): Promise<ShellProfile[]> {
  const profiles = await machineCache.get<ShellProfile[]>(CACHE_KEY);
  return profiles ?? [];
}

/**
 * Save a new profile.
 */
export async function saveProfile(profile: Omit<ShellProfile, "id" | "createdAt">): Promise<void> {
  const profiles = await getProfiles();
  
  const newProfile: ShellProfile = {
    ...profile,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  
  profiles.unshift(newProfile);
  const trimmed = profiles.slice(0, MAX_PROFILES);
  
  await machineCache.set(CACHE_KEY, trimmed);
}

/**
 * Delete a profile by ID.
 */
export async function deleteProfile(id: string): Promise<void> {
  const profiles = await getProfiles();
  const filtered = profiles.filter(p => p.id !== id);
  await machineCache.set(CACHE_KEY, filtered);
}

/**
 * Get a profile by ID.
 */
export async function getProfile(id: string): Promise<ShellProfile | null> {
  const profiles = await getProfiles();
  return profiles.find(p => p.id === id) ?? null;
}
