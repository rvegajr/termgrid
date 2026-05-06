/**
 * Workspace persistence — saves tab/pane structure to localStorage so the
 * app reopens with the same layout. PTY processes can't survive app restart;
 * we restore the *visual* state by replaying each pane's saved scrollback
 * (see pane-snapshot.ts) into a freshly-spawned shell.
 */

// Bumped to v2: layoutPreset moved per-tab; added edgeOffsets keyed by stableId.
// v1 entries silently fall through to EMPTY (welcome screen on first launch).
const KEY = "termgrid.workspace.v2";

export interface PersistedPane {
  stableId: string;
  shellType?: string;
  cwd?: string;
}

export interface PersistedTab {
  id: string;
  name: string;
  paneStableIds: string[];
  layoutPreset?: string;
}

export interface PersistedEdgeOffsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Workspace {
  tabs: PersistedTab[];
  activeTabId: string | null;
  panes: Record<string, PersistedPane>;
  /** Per-pane resize-edge overrides, keyed by stableId so they survive PTY rotation. */
  edgeOffsets: Record<string, PersistedEdgeOffsets>;
  /** Fallback for tabs that don't carry their own layoutPreset (back-compat). */
  defaultLayoutPreset: string;
  /** Epoch ms of the last save — used to render a "last used" hint on the welcome screen. */
  savedAt?: number;
}

const EMPTY: Workspace = {
  tabs: [],
  activeTabId: null,
  panes: {},
  edgeOffsets: {},
  defaultLayoutPreset: "auto",
};

/** True if a real saved workspace exists (≥1 tab with ≥1 pane). */
export function hasSavedWorkspace(): boolean {
  const ws = loadWorkspace();
  return ws.tabs.length > 0 && ws.tabs.some((t) => t.paneStableIds.length > 0);
}

/** Quick summary for the welcome screen restore button. */
export function describeSavedWorkspace(): { tabCount: number; paneCount: number; savedAt?: number } {
  const ws = loadWorkspace();
  const paneCount = ws.tabs.reduce((sum, t) => sum + t.paneStableIds.length, 0);
  return { tabCount: ws.tabs.length, paneCount, savedAt: ws.savedAt };
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Workspace;
    if (!parsed || !Array.isArray(parsed.tabs)) return EMPTY;
    return { ...EMPTY, ...parsed };
  } catch {
    return EMPTY;
  }
}

let saveTimer: number | null = null;
export function saveWorkspace(ws: Workspace) {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      const stamped: Workspace = { ...ws, savedAt: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(stamped));
    } catch {}
  }, 250);
}

export function clearWorkspace() {
  try { localStorage.removeItem(KEY); } catch {}
}

export function newStableId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "p-" + Math.random().toString(36).slice(2, 12);
}
