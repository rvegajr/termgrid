/**
 * Per-pane "where am I" context: local hostname, or ssh-remoted host.
 *
 * Backed by a periodic poll of the Rust `pane_remote_context` command.
 * Decoupled from `pane-meta.ts` because that module is OSC-sniff driven
 * and this signal is process-tree driven — different cadence, different
 * source of truth.
 */

import { createSignal } from "solid-js";
import { paneRemoteContext, panesRemoteContext, type RemoteContext } from "./adoption";

const [hostMap, setHostMap] = createSignal<Record<string, RemoteContext>>({});

export const paneHostMap = hostMap;

export function paneHost(paneId: string): RemoteContext | undefined {
  return hostMap()[paneId];
}

/**
 * Refresh the host context for one pane. Cheap; safe to call frequently.
 * Skips the update if nothing changed (keeps signal subscribers quiet).
 */
export async function refreshPaneHost(paneId: string): Promise<void> {
  let ctx: RemoteContext | null;
  try {
    ctx = await paneRemoteContext(paneId);
  } catch {
    return;
  }
  if (!ctx) return;
  setHostMap((prev) => {
    const cur = prev[paneId];
    if (cur && sameContext(cur, ctx!)) return prev;
    return { ...prev, [paneId]: ctx! };
  });
}

/**
 * Batched refresh: scan process tree once and resolve all pane contexts.
 * Much more efficient than calling refreshPaneHost for each pane.
 */
export async function refreshPaneHostsBatch(paneIds: string[]): Promise<void> {
  if (paneIds.length === 0) return;
  
  let results: Array<[string, RemoteContext | null]>;
  try {
    results = await panesRemoteContext(paneIds);
  } catch {
    return;
  }
  
  setHostMap((prev) => {
    let changed = false;
    const next = { ...prev };
    
    for (const [paneId, ctx] of results) {
      if (!ctx) continue;
      const cur = prev[paneId];
      if (!cur || !sameContext(cur, ctx)) {
        next[paneId] = ctx;
        changed = true;
      }
    }
    
    return changed ? next : prev;
  });
}

export function forgetPaneHost(paneId: string): void {
  setHostMap((prev) => {
    if (!(paneId in prev)) return prev;
    const next = { ...prev };
    delete next[paneId];
    return next;
  });
}

function sameContext(a: RemoteContext, b: RemoteContext): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "local" && b.kind === "local") {
    return a.host === b.host;
  }
  if (a.kind === "ssh" && b.kind === "ssh") {
    return (
      a.destination === b.destination &&
      a.host === b.host &&
      a.port === b.port
    );
  }
  return false;
}

/**
 * Format a `RemoteContext` for the pane header — kept short on purpose
 * since the label competes for space with cwd/branch/shell.
 *
 * Returns:
 *   - `null` when the result is the boring local case and the caller
 *     wants to hide the badge.
 *   - A short string like `"ssh → me@prod-web"` otherwise.
 */
export function formatPaneHost(ctx: RemoteContext | undefined): string | null {
  if (!ctx) return null;
  if (ctx.kind === "local") {
    // Show local hostname tucked in subtly. Callers can also choose to
    // hide this; we surface it so the user always knows which machine
    // they're on (matters when running TermGrid across laptops).
    return ctx.host;
  }
  return `ssh → ${ctx.destination}`;
}
