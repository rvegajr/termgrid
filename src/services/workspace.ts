/**
 * Workspace persistence — saves tab/pane structure to localStorage so the
 * app reopens with the same layout. PTY processes can't survive app restart;
 * we restore the *visual* state by replaying each pane's saved scrollback
 * (see pane-snapshot.ts) into a freshly-spawned shell.
 */

const KEY = "termgrid.workspace.v1";

export interface PersistedPane {
  stableId: string;
  shellType?: string;
  cwd?: string;
}

export interface PersistedTab {
  id: string;
  name: string;
  paneStableIds: string[];
}

export interface Workspace {
  tabs: PersistedTab[];
  activeTabId: string | null;
  panes: Record<string, PersistedPane>;
  layoutPreset: string;
}

const EMPTY: Workspace = {
  tabs: [],
  activeTabId: null,
  panes: {},
  layoutPreset: "auto",
};

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
      localStorage.setItem(KEY, JSON.stringify(ws));
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
