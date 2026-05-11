import { createSignal } from "solid-js";
import * as machineCache from "./machine-cache";

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  scrollbackLines: number;
  autoRestoreWithinHours: number;
}

export interface CellDimensions {
  width: number;
  height: number;
}

const KEY = "termgrid.termPrefs";

export const FONT_OPTIONS = [
  "Cascadia Code",
  "Fira Code",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Ubuntu Mono",
  "Berkeley Mono",
];

const FALLBACK_STACK =
  "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, monospace";

const DEFAULT: TerminalPrefs = {
  fontFamily: "Cascadia Code",
  fontSize: 14,
  cursorBlink: true,
  scrollbackLines: 10_000,
  autoRestoreWithinHours: 4,
};

function load(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT;
}

const [prefs, setPrefs] = createSignal<TerminalPrefs>(load());

export const terminalPrefs = prefs;

export function updatePrefs(patch: Partial<TerminalPrefs>) {
  const next = { ...prefs(), ...patch };
  setPrefs(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
}

/** Quoted stack for xterm: chosen font first, then fallbacks. */
export function fontStack(p: TerminalPrefs = prefs()): string {
  const chosen = p.fontFamily.includes(" ") ? `'${p.fontFamily}'` : p.fontFamily;
  return `${chosen}, ${FALLBACK_STACK}`;
}

/**
 * Build cache key for cell dimensions: `font|size|dpr`
 * Cell dimensions depend on font family, size, and device pixel ratio.
 */
function cellDimsCacheKey(p: TerminalPrefs = prefs()): string {
  const dpr = window.devicePixelRatio || 1;
  return `${p.fontFamily}|${p.fontSize}|${dpr}`;
}

/**
 * Load cached cell dimensions for the current terminal preferences.
 * Returns null if no cache exists for this font/size/dpr combo.
 */
export async function loadCachedCellDimensions(): Promise<CellDimensions | null> {
  const key = cellDimsCacheKey();
  const cache = await machineCache.get<Record<string, CellDimensions>>("cellDimensions");
  return cache?.[key] ?? null;
}

/**
 * Save cell dimensions to cache for the current terminal preferences.
 */
export async function saveCellDimensions(dims: CellDimensions): Promise<void> {
  const key = cellDimsCacheKey();
  const cache = await machineCache.get<Record<string, CellDimensions>>("cellDimensions") ?? {};
  cache[key] = dims;
  await machineCache.set("cellDimensions", cache);
}
