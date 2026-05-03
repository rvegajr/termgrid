import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import * as ipc from "./tauri-ipc";

/**
 * Per-pane snapshot manager — restores xterm scrollback from disk on mount,
 * debounce-saves while the pane is alive, deletes when the pane is closed.
 *
 * Capacity notes:
 * - xterm scrollback set to 100k lines (~10–20 MB RAM/pane).
 * - On-disk snapshot is the serialized terminal state (ANSI included).
 *   Real-world ~0.5–2 MB per pane; saved every 5 s while dirty.
 */
const DEBOUNCE_MS = 5000;
const STABLE_KEY = "termgrid.paneIds";

export interface SnapshotHandle {
  serialize: SerializeAddon;
  scheduleSave: () => void;
  flush: () => Promise<void>;
  destroy: (deleteFromDisk: boolean) => Promise<void>;
}

/**
 * The xterm `pane.id` we generate at runtime is `pane-0`, `pane-1`… and isn't
 * stable across restarts. We map a runtime id to a *stable* id stored in
 * localStorage (per tab+slot index). Snapshots are keyed by stable id.
 *
 * For v1 we just use the runtime id as the stable key, and clean up orphans
 * on app start. Tabs/panes are not yet themselves persisted — that's a
 * separate concern.
 */
export function attachSnapshot(paneId: string, terminal: Terminal): SnapshotHandle {
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);

  let timer: number | null = null;
  let dirty = false;
  let destroyed = false;

  terminal.onWriteParsed(() => {
    dirty = true;
    scheduleSave();
  });

  function scheduleSave() {
    if (destroyed) return;
    if (timer !== null) return;
    timer = window.setTimeout(async () => {
      timer = null;
      if (!dirty || destroyed) return;
      dirty = false;
      try {
        await ipc.snapshotSave(paneId, serialize.serialize());
      } catch (e) {
        console.warn("[snapshot] save failed:", e);
      }
    }, DEBOUNCE_MS);
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!destroyed) {
      try {
        await ipc.snapshotSave(paneId, serialize.serialize());
      } catch (e) {
        console.warn("[snapshot] flush failed:", e);
      }
    }
  }

  async function destroy(deleteFromDisk: boolean) {
    destroyed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (deleteFromDisk) {
      try { await ipc.snapshotDelete(paneId); } catch {}
    }
  }

  return { serialize, scheduleSave, flush, destroy };
}

export async function restoreSnapshot(paneId: string, terminal: Terminal): Promise<boolean> {
  try {
    const saved = await ipc.snapshotLoad(paneId);
    if (saved && saved.length > 0) {
      terminal.write(saved);
      return true;
    }
  } catch (e) {
    console.warn("[snapshot] restore failed:", e);
  }
  return false;
}

export function rememberPaneId(id: string) {
  try {
    const list = JSON.parse(localStorage.getItem(STABLE_KEY) || "[]") as string[];
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(STABLE_KEY, JSON.stringify(list));
    }
  } catch {}
}

export function forgetPaneId(id: string) {
  try {
    const list = JSON.parse(localStorage.getItem(STABLE_KEY) || "[]") as string[];
    localStorage.setItem(STABLE_KEY, JSON.stringify(list.filter((x) => x !== id)));
  } catch {}
}

/** Wipe every on-disk snapshot file — used by "Reset workspace". */
export async function purgeAllSnapshots(): Promise<void> {
  try {
    const list = JSON.parse(localStorage.getItem(STABLE_KEY) || "[]") as string[];
    await Promise.all(list.map((id) => ipc.snapshotDelete(id).catch(() => {})));
    localStorage.setItem(STABLE_KEY, "[]");
  } catch {}
  // Also nuke any orphans listed by the backend.
  try {
    const all = await (ipc as any).snapshotList?.();
    if (Array.isArray(all)) {
      await Promise.all(all.map((id: string) => ipc.snapshotDelete(id).catch(() => {})));
    }
  } catch {}
}
