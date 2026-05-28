/**
 * Workspace reconcile — the safety valve that decides what we are *allowed*
 * to persist, given the current runtime state and the workspace we loaded at
 * launch.
 *
 * Why this exists
 * ---------------
 * The persist effect fires immediately after restore and re-writes the
 * workspace from runtime state. If restore was incomplete — a pane failed to
 * spawn (and was skipped), or restore fell back to a single empty picker tab —
 * that degraded state would otherwise be committed straight over the on-disk
 * source of truth, permanently destroying tabs/panes the user never closed.
 * (Confirmed in the field: a 7-pane session ratcheted down to 4.)
 *
 * The invariant this enforces
 * ---------------------------
 *   The saved workspace is only ever SHRUNK by an explicit user close.
 *   A restore hiccup can never delete a tab or pane.
 *
 * How
 * ---
 * We merge the runtime workspace with the launch baseline:
 *   - Panes alive in runtime are saved as-is (this captures user edits:
 *     new panes, new tabs, renames, reorders, layout changes).
 *   - A baseline pane that is MISSING from runtime is preserved IFF it was
 *     not explicitly closed this session (not in `tombstones`). A missing,
 *     non-tombstoned pane means "failed/declined to restore" — keep it so the
 *     next launch retries it, instead of silently dropping it forever.
 *   - A baseline pane that is missing AND tombstoned was deliberately closed,
 *     so it is dropped.
 *
 * Tombstones (the set of stableIds the user explicitly closed) are the only
 * thing that authorizes removal. They're tracked at every close site in the
 * app (close pane, close tab, load template). Using an explicit set — rather
 * than probing snapshot files — avoids a race between the async snapshot
 * delete and the synchronous persist effect.
 */
import type {
  Workspace,
  PersistedTab,
  PersistedPane,
  PersistedEdgeOffsets,
} from "./workspace";

export interface ReconcileInput {
  /** Workspace derived from current runtime signals (tabs/panes/layouts). */
  runtime: Workspace;
  /** Workspace loaded from disk at launch — the authoritative prior state. */
  baseline: Workspace;
  /** stableIds the user explicitly closed this session (authorizes removal). */
  tombstones: Set<string>;
}

export function reconcileWorkspace({
  runtime,
  baseline,
  tombstones,
}: ReconcileInput): Workspace {
  const runtimePaneIds = new Set(Object.keys(runtime.panes));
  const baselineTabById = new Map(baseline.tabs.map((t) => [t.id, t]));

  // A baseline pane survives a missing-from-runtime situation only if the
  // user did not explicitly close it. (If it's in runtime it's obviously kept.)
  const shouldPreserveMissing = (sid: string) =>
    !runtimePaneIds.has(sid) && !tombstones.has(sid);

  const resultTabs: PersistedTab[] = [];
  const emittedTabIds = new Set<string>();

  // 1. Walk runtime tabs in their current order (the user's live ordering is
  //    authoritative). For tabs that also exist in the baseline, merge the
  //    pane lists so failed-to-restore panes are reinserted at their original
  //    slots; brand-new tabs pass through untouched.
  for (const rt of runtime.tabs) {
    const bt = baselineTabById.get(rt.id);
    if (!bt) {
      resultTabs.push(rt);
      emittedTabIds.add(rt.id);
      continue;
    }
    resultTabs.push({
      id: rt.id,
      name: rt.name,
      layoutPreset: rt.layoutPreset,
      paneStableIds: mergePaneOrder(
        bt.paneStableIds,
        rt.paneStableIds,
        runtimePaneIds,
        tombstones,
      ),
    });
    emittedTabIds.add(rt.id);
  }

  // 2. Re-add baseline tabs that are entirely absent from runtime (a whole tab
  //    failed to restore), as long as they still hold ≥1 non-closed pane.
  //    Insert near the original index so ordering stays intuitive.
  for (let i = 0; i < baseline.tabs.length; i++) {
    const bt = baseline.tabs[i];
    if (emittedTabIds.has(bt.id)) continue;
    const survivors = bt.paneStableIds.filter(shouldPreserveMissing);
    if (survivors.length === 0) continue;
    const insertAt = Math.min(i, resultTabs.length);
    resultTabs.splice(insertAt, 0, { ...bt, paneStableIds: survivors });
    emittedTabIds.add(bt.id);
  }

  // 3. Rebuild the panes map for every stableId referenced by the result.
  //    Prefer the live runtime descriptor (fresh shellType); fall back to the
  //    baseline descriptor for preserved-but-missing panes.
  const panes: Record<string, PersistedPane> = {};
  for (const tab of resultTabs) {
    for (const sid of tab.paneStableIds) {
      if (panes[sid]) continue;
      panes[sid] = runtime.panes[sid] ?? baseline.panes[sid] ?? { stableId: sid };
    }
  }

  // 4. Edge offsets: keep runtime offsets, then fill in baseline offsets for
  //    any preserved pane that runtime no longer knows about.
  const edgeOffsets: Record<string, PersistedEdgeOffsets> = {
    ...(runtime.edgeOffsets ?? {}),
  };
  for (const sid of Object.keys(panes)) {
    if (!edgeOffsets[sid] && baseline.edgeOffsets?.[sid]) {
      edgeOffsets[sid] = baseline.edgeOffsets[sid];
    }
  }

  // 5. Active tab: prefer runtime's choice, else baseline's, else first tab.
  const validTabIds = new Set(resultTabs.map((t) => t.id));
  const activeTabId =
    (runtime.activeTabId && validTabIds.has(runtime.activeTabId)
      ? runtime.activeTabId
      : baseline.activeTabId && validTabIds.has(baseline.activeTabId)
        ? baseline.activeTabId
        : resultTabs[0]?.id) ?? null;

  return {
    tabs: resultTabs,
    activeTabId,
    panes,
    edgeOffsets,
    defaultLayoutPreset: runtime.defaultLayoutPreset || baseline.defaultLayoutPreset || "auto",
    savedAt: runtime.savedAt,
  };
}

/**
 * Merge a tab's pane ordering. Walk the baseline order first (so restored
 * panes keep their slots), then append any runtime panes new to this tab.
 *
 * A baseline pane is kept in this tab when it is either:
 *   - still a member of this runtime tab (`runtimeIds`), or
 *   - missing from runtime *entirely* and not closed (`allRuntimePaneIds`,
 *     `tombstones`) — i.e. it failed to restore, so we hold its slot.
 *
 * Crucially, a pane that is alive in a *different* tab (the user moved it via
 * break-out / merge) is neither in this tab nor "missing entirely", so it is
 * correctly NOT re-added here — preventing a duplicate.
 */
function mergePaneOrder(
  baselineIds: string[],
  runtimeIds: string[],
  allRuntimePaneIds: Set<string>,
  tombstones: Set<string>,
): string[] {
  const runtimeTabSet = new Set(runtimeIds);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const sid of baselineIds) {
    const stillInThisTab = runtimeTabSet.has(sid);
    const failedToRestore = !allRuntimePaneIds.has(sid) && !tombstones.has(sid);
    if ((stillInThisTab || failedToRestore) && !seen.has(sid)) {
      merged.push(sid);
      seen.add(sid);
    }
  }
  for (const sid of runtimeIds) {
    if (!seen.has(sid)) {
      merged.push(sid);
      seen.add(sid);
    }
  }
  return merged;
}
