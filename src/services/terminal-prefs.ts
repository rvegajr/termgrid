import { createSignal } from "solid-js";

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
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
