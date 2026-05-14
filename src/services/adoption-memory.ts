/**
 * Persisted adoption memory (v4).
 *
 * After the user adopts a session we record a small fingerprint into
 * `localStorage` so we can:
 *   - Surface "Reopen previously-adopted dirs" on the welcome screen.
 *   - Detect adoption-style usage patterns and tune defaults
 *     (e.g. auto-pre-filter the picker by the most-used parent app).
 *
 * Bounded storage: keep at most {@link MAX_ENTRIES} entries, oldest
 * evicted first. Each entry is < 1 KiB, so the total footprint is well
 * inside browser quota even on the upper bound.
 *
 * What we DO NOT persist:
 *   - The full `SessionSnapshot.buffer_preview` (potentially sensitive
 *     terminal output).
 *   - Any env values (we already filter to allow-list at capture, but
 *     we keep an extra layer of defense by storing only the *names*).
 *   - SSH command lines (could include user@host that the user doesn't
 *     want trivially listed). We do persist the *destination* alone if
 *     the user explicitly opts in via `keepSshHosts: true`, defaulting
 *     to false.
 *
 * Pure module — no I/O outside localStorage. Safe to import on every
 * page (welcome screen, picker, palette).
 */

const STORAGE_KEY = "termgrid.adoption.memory.v1";
const MAX_ENTRIES = 50;

export interface AdoptionMemoryEntry {
  /** Absolute timestamp (ms since epoch) the adoption happened. */
  adoptedAt: number;
  /** Shell basename (`"zsh"`, etc.). Useful for filtering. */
  shell: string;
  /** Working directory at adoption time. `null` if unknown. */
  cwd: string | null;
  /**
   * Terminal-host the source belonged to (`"Terminal"`, `"Cursor Helper"`,
   * `"tmux"`), if any.
   */
  parent: string | null;
  /**
   * Toolchain env var **names** seen at adoption time (no values).
   * Drives "this dir typically has direnv" hints.
   */
  envNames: string[];
  /** SSH destination — only when user opted in (default off). */
  sshDestination?: string;
  /** What `mode` the user picked (informational). */
  mode: "new-tab" | "active-pane" | "split";
}

interface StoredShape {
  version: 1;
  entries: AdoptionMemoryEntry[];
}

function read(): StoredShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, entries: [] };
    const parsed = JSON.parse(raw) as StoredShape;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // Corrupted JSON or storage denied — start clean.
  }
  return { version: 1, entries: [] };
}

function write(shape: StoredShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Quota exceeded or storage denied — drop oldest half and retry once.
    if (shape.entries.length > 1) {
      const trimmed: StoredShape = {
        version: 1,
        entries: shape.entries.slice(-Math.floor(shape.entries.length / 2)),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      } catch {
        /* give up */
      }
    }
  }
}

/**
 * Append one adoption to the persisted history.
 *
 * De-dupes by `(cwd, shell)` within the last 10 entries so that
 * adopting the same project shell repeatedly doesn't crowd out older
 * variety. The most recent entry for the dedup key keeps its position
 * (refreshed timestamp).
 */
export function recordAdoption(entry: AdoptionMemoryEntry): void {
  const shape = read();
  // De-dupe: drop any recent entry with the same (cwd, shell).
  const isDup = (e: AdoptionMemoryEntry) =>
    e.cwd === entry.cwd && e.shell === entry.shell;
  const recentWindow = shape.entries.slice(-10);
  if (recentWindow.some(isDup)) {
    shape.entries = shape.entries.filter((e) => !isDup(e));
  }
  shape.entries.push(entry);
  // Bound the total length.
  if (shape.entries.length > MAX_ENTRIES) {
    shape.entries = shape.entries.slice(-MAX_ENTRIES);
  }
  write(shape);
}

/** Most recent first. */
export function listAdoptions(): AdoptionMemoryEntry[] {
  return [...read().entries].reverse();
}

/**
 * Distinct directories from the persisted log, most-recent-first, capped
 * at `limit`. Used by the welcome screen's "Reopen adopted dirs" row.
 */
export function recentAdoptedCwds(limit = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of listAdoptions()) {
    if (!e.cwd) continue;
    if (seen.has(e.cwd)) continue;
    seen.add(e.cwd);
    out.push(e.cwd);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The parent app the user adopts from most often, useful as a hint for
 * picker pre-filtering. `null` if there's not enough data.
 */
export function dominantParent(): string | null {
  const counts = new Map<string, number>();
  for (const e of read().entries) {
    if (!e.parent) continue;
    counts.set(e.parent, (counts.get(e.parent) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: [string, number] | null = null;
  for (const pair of counts.entries()) {
    if (!best || pair[1] > best[1]) best = pair;
  }
  return best?.[0] ?? null;
}

/** Wipe the entire adoption history. */
export function clearAdoptionMemory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * **v5:** Export the adoption memory to a JSON file.
 *
 * Opens a save-file dialog, serializes the current memory to JSON, and
 * writes it. Returns `true` on success, `false` if the user canceled or
 * the write failed.
 */
export async function exportAdoptionMemory(): Promise<boolean> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");

    const path = await save({
      defaultPath: `termgrid-adoption-history-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!path) return false; // User canceled

    const shape = read();
    const json = JSON.stringify(shape, null, 2);
    await writeTextFile(path, json);
    return true;
  } catch (err) {
    console.error("exportAdoptionMemory failed:", err);
    return false;
  }
}

/**
 * **v5:** Import adoption memory from a JSON file.
 *
 * Opens an open-file dialog, reads the JSON, validates its shape, and
 * merges it into the existing memory (de-duping by cwd+shell). Returns
 * the number of entries imported, or `-1` on error/cancel.
 */
export async function importAdoptionMemory(): Promise<number> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");

    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!path || typeof path !== "string") return -1; // User canceled

    const text = await readTextFile(path);
    const parsed = JSON.parse(text) as unknown;

    // Validate shape
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("entries" in parsed) ||
      !Array.isArray((parsed as { entries: unknown }).entries)
    ) {
      console.error("Invalid adoption memory file shape");
      return -1;
    }

    const imported = (parsed as StoredShape).entries;
    const current = read();

    // Merge: append imported entries, then de-dupe by (cwd, shell, adoptedAt)
    const keyFn = (e: AdoptionMemoryEntry) =>
      `${e.cwd}:${e.shell}:${e.adoptedAt}`;
    const seen = new Set<string>();
    const merged: AdoptionMemoryEntry[] = [];

    for (const e of [...current.entries, ...imported]) {
      const k = keyFn(e);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(e);
      }
    }

    // Sort by adoptedAt ascending, keep last MAX_ENTRIES
    merged.sort((a, b) => a.adoptedAt - b.adoptedAt);
    const trimmed = merged.slice(-MAX_ENTRIES);

    write({ version: 1, entries: trimmed });
    return imported.length;
  } catch (err) {
    console.error("importAdoptionMemory failed:", err);
    return -1;
  }
}
