/**
 * Machine-fingerprinted persistent cache using localStorage.
 * 
 * All keys are prefixed with `tg.cache.v1.<name>` and include a machine
 * fingerprint to automatically invalidate when config syncs to a different
 * machine. Bumping the `v1` version is the migration story.
 */

import { createSignal, onCleanup } from 'solid-js';

const CACHE_VERSION = 'v1';
const KEY_PREFIX = 'tg.cache';
const WRITE_DEBOUNCE_MS = 250;

let machineFingerprint: string | null = null;

interface CacheEntry<T> {
  value: T;
  fingerprint: string;
  savedAt: number;
}

/**
 * Compute a stable machine fingerprint from browser and app metadata.
 * Uses SHA-1 (via SubtleCrypto) of: userAgent + appVersion + colorDepth.
 */
async function computeFingerprint(): Promise<string> {
  if (machineFingerprint) {
    return machineFingerprint;
  }

  const ua = navigator.userAgent;
  const appVersion = import.meta.env.VITE_APP_VERSION || '0.1.0';
  const colorDepth = screen.colorDepth.toString();
  const raw = `${ua}|${appVersion}|${colorDepth}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  machineFingerprint = hashHex;
  return machineFingerprint;
}

/**
 * Build the full localStorage key.
 */
function buildKey(name: string): string {
  return `${KEY_PREFIX}.${CACHE_VERSION}.${name}`;
}

/**
 * Read a value from the cache. Returns undefined if:
 * - Key doesn't exist
 * - Fingerprint doesn't match (wrong machine)
 * - JSON parse fails
 */
export async function get<T>(name: string): Promise<T | undefined> {
  const key = buildKey(name);
  const raw = localStorage.getItem(key);
  if (!raw) {
    return undefined;
  }

  try {
    const entry = JSON.parse(raw) as CacheEntry<T>;
    const fingerprint = await computeFingerprint();

    if (entry.fingerprint !== fingerprint) {
      // Wrong machine, invalidate
      localStorage.removeItem(key);
      return undefined;
    }

    return entry.value;
  } catch {
    // Corrupt data
    localStorage.removeItem(key);
    return undefined;
  }
}

/**
 * Write queue for atomic, debounced writes.
 */
interface PendingWrite {
  key: string;
  entry: CacheEntry<unknown>;
}

const pendingWrites = new Map<string, PendingWrite>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushWrites() {
  const writtenKeys: string[] = [];
  
  for (const { key, entry } of pendingWrites.values()) {
    try {
      localStorage.setItem(key, JSON.stringify(entry));
      writtenKeys.push(key);
    } catch (e) {
      console.error(`[machine-cache] Failed to write ${key}:`, e);
    }
  }
  pendingWrites.clear();
  writeTimer = null;

  // Notify subscribers after clearing pending writes
  for (const key of writtenKeys) {
    notifySubscribers(key);
  }
}

function scheduleWrite(key: string, entry: CacheEntry<unknown>) {
  pendingWrites.set(key, { key, entry });

  if (writeTimer) {
    clearTimeout(writeTimer);
  }

  writeTimer = setTimeout(flushWrites, WRITE_DEBOUNCE_MS);
}

/**
 * Write a value to the cache. Debounced to avoid losing data on rapid updates.
 */
export async function set<T>(name: string, value: T): Promise<void> {
  const key = buildKey(name);
  const fingerprint = await computeFingerprint();
  const entry: CacheEntry<T> = {
    value,
    fingerprint,
    savedAt: Date.now(),
  };

  scheduleWrite(key, entry as CacheEntry<unknown>);
}

/**
 * Remove a value from the cache.
 */
export function remove(name: string): void {
  const key = buildKey(name);
  localStorage.removeItem(key);
  pendingWrites.delete(key);
  notifySubscribers(key);
}

/**
 * Subscription system for live updates.
 */
type Subscriber<T> = (value: T | undefined) => void;
const subscribers = new Map<string, Set<Subscriber<unknown>>>();

function notifySubscribers(key: string) {
  const subs = subscribers.get(key);
  if (!subs) return;

  // Extract name from key
  const prefix = `${KEY_PREFIX}.${CACHE_VERSION}.`;
  if (!key.startsWith(prefix)) return;
  const name = key.slice(prefix.length);

  get(name).then(value => {
    for (const fn of subs) {
      fn(value);
    }
  });
}

/**
 * Subscribe to changes to a cache key. Returns an unsubscribe function.
 * Also integrates with SolidJS reactivity when called inside a tracking scope.
 */
export function subscribe<T>(name: string, fn: Subscriber<T>): () => void {
  const key = buildKey(name);
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }

  subs.add(fn as Subscriber<unknown>);

  // Call immediately with current value
  get<T>(name).then(fn);

  const unsubscribe = () => {
    subs?.delete(fn as Subscriber<unknown>);
    if (subs?.size === 0) {
      subscribers.delete(key);
    }
  };

  // Auto-cleanup in SolidJS
  try {
    onCleanup(unsubscribe);
  } catch {
    // Not in a tracking scope, caller must call unsubscribe manually
  }

  return unsubscribe;
}

/**
 * Create a reactive Solid signal backed by the cache.
 */
export function createCachedSignal<T>(name: string, defaultValue: T) {
  const [value, setValue] = createSignal<T>(defaultValue);

  // Load initial value
  get<T>(name).then(cached => {
    if (cached !== undefined) {
      setValue(() => cached);
    }
  });

  // Subscribe to changes
  subscribe<T>(name, newValue => {
    if (newValue !== undefined) {
      setValue(() => newValue);
    }
  });

  // Wrap setter to also persist
  const wrappedSetter = (newValue: T | ((prev: T) => T)) => {
    setValue(newValue as any);
    const resolved = typeof newValue === 'function' ? (newValue as any)(value()) : newValue;
    set(name, resolved);
  };

  return [value, wrappedSetter] as const;
}
