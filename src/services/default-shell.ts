import { createSignal } from "solid-js";

/**
 * Global default shell preference.
 *
 * When set, every new tab/pane launches this shell instead of the
 * system default. Persisted to localStorage so it survives restarts.
 * `null` means "use the system default".
 */

const KEY = "termgrid.defaultShell";

function load(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const [shell, setShell] = createSignal<string | null>(load());

export const defaultShell = shell;

export function setDefaultShell(path: string | null) {
  setShell(path);
  try {
    if (path) localStorage.setItem(KEY, path);
    else localStorage.removeItem(KEY);
  } catch {}
}
