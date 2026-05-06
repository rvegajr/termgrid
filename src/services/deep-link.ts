import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

/**
 * Deep-link handler for `termgrid://...` URLs.
 *
 * Wire format:
 *   termgrid://open?path=<encoded-path>&mode=<existing|unused|new-tab>
 *
 * Modes:
 *   existing  — `cd <path>` in the currently focused pane (or last-active pane)
 *   unused    — find a pane in the active tab that's at $HOME / hasn't run a
 *               command yet, `cd <path>` there. If none, spawn a new pane.
 *   new-tab   — always create a new tab with one pane in `<path>`
 *
 * Triggered by:
 *   - macOS Finder Quick Action (Automator → `open termgrid://...`)
 *   - Windows Explorer right-click (registry shell entry → `start termgrid://...`)
 *   - Linux Nautilus action (.desktop file → `xdg-open termgrid://...`)
 */

export interface OpenRequest {
  path: string;
  mode: "existing" | "unused" | "new-tab";
}

type Handler = (req: OpenRequest) => void;
const handlers = new Set<Handler>();

export function onOpenRequest(fn: Handler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

let installed = false;
export async function installDeepLinkHandler(): Promise<void> {
  if (installed) return;
  installed = true;
  await onOpenUrl((urls) => {
    for (const raw of urls) {
      const req = parse(raw);
      if (req) handlers.forEach((h) => h(req));
    }
  });
}

function parse(raw: string): OpenRequest | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "termgrid:") return null;
    if (u.host !== "open") return null;
    const path = u.searchParams.get("path");
    if (!path) return null;
    const modeStr = (u.searchParams.get("mode") || "unused").toLowerCase();
    const mode: OpenRequest["mode"] =
      modeStr === "existing" ? "existing" :
      modeStr === "new-tab" || modeStr === "newtab" ? "new-tab" :
      "unused";
    return { path, mode };
  } catch {
    return null;
  }
}
