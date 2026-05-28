import { describe, it, expect } from "vitest";
import { reconcileWorkspace } from "../services/workspace-reconcile";
import type { Workspace, PersistedPane } from "../services/workspace";

function pane(stableId: string, shellType = "default"): PersistedPane {
  return { stableId, shellType };
}

function ws(partial: Partial<Workspace>): Workspace {
  return {
    tabs: [],
    activeTabId: null,
    panes: {},
    edgeOffsets: {},
    defaultLayoutPreset: "auto",
    ...partial,
  };
}

/** A realistic two-tab baseline: 1 pane + 6 panes (the session that was lost). */
function baseline7(): Workspace {
  const sids = ["a", "b", "c", "d", "e", "f", "g"];
  return ws({
    activeTabId: "tab-1",
    tabs: [
      { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
      {
        id: "tab-2",
        name: "Grid 2",
        paneStableIds: ["b", "c", "d", "e", "f", "g"],
        layoutPreset: "grid-3x2",
      },
    ],
    panes: Object.fromEntries(sids.map((s) => [s, pane(s)])),
  });
}

describe("reconcileWorkspace", () => {
  it("passes through a fully-successful restore unchanged (no degradation)", () => {
    const base = baseline7();
    // Runtime mirrors the baseline exactly (every pane respawned).
    const runtime = baseline7();
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    expect(result.tabs.map((t) => t.paneStableIds)).toEqual([
      ["a"],
      ["b", "c", "d", "e", "f", "g"],
    ]);
    expect(Object.keys(result.panes).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("preserves panes that failed to restore (missing from runtime, not closed)", () => {
    const base = baseline7();
    // Restore dropped panes d, f (e.g. transient spawn failures) — runtime
    // only has a, b, c, e, g across the two tabs.
    const runtime = ws({
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "c", "e", "g"], layoutPreset: "grid-3x2" },
      ],
      panes: { a: pane("a"), b: pane("b"), c: pane("c"), e: pane("e"), g: pane("g") },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    // d and f are reinserted at their original slots; nothing is lost.
    expect(result.tabs[1].paneStableIds).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(Object.keys(result.panes).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("does NOT resurrect panes the user explicitly closed (tombstoned)", () => {
    const base = baseline7();
    // User closed pane c; runtime reflects that. c is tombstoned.
    const runtime = ws({
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "d", "e", "f", "g"], layoutPreset: "grid-3x2" },
      ],
      panes: { a: pane("a"), b: pane("b"), d: pane("d"), e: pane("e"), f: pane("f"), g: pane("g") },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set(["c"]) });
    expect(result.tabs[1].paneStableIds).toEqual(["b", "d", "e", "f", "g"]);
    expect(result.panes).not.toHaveProperty("c");
  });

  it("protects the whole workspace when restore totally fails (empty-tab fallback)", () => {
    const base = baseline7();
    // Catastrophic restore failure: runtime is a single brand-new empty
    // picker tab, nothing tombstoned. The saved workspace must survive intact.
    const runtime = ws({
      activeTabId: "tab-9",
      tabs: [{ id: "tab-9", name: "Tab 1", paneStableIds: [], layoutPreset: "auto" }],
      panes: {},
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    // Both original tabs (and all 7 panes) are re-added; the empty picker tab
    // is kept too but adds no data loss.
    const tab1 = result.tabs.find((t) => t.id === "tab-1");
    const tab2 = result.tabs.find((t) => t.id === "tab-2");
    expect(tab1?.paneStableIds).toEqual(["a"]);
    expect(tab2?.paneStableIds).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(Object.keys(result.panes).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("keeps brand-new tabs and panes added this session", () => {
    const base = baseline7();
    const runtime = ws({
      activeTabId: "tab-3",
      tabs: [
        { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "c", "d", "e", "f", "g"], layoutPreset: "grid-3x2" },
        { id: "tab-3", name: "New", paneStableIds: ["x"], layoutPreset: "auto" },
      ],
      panes: {
        a: pane("a"), b: pane("b"), c: pane("c"), d: pane("d"),
        e: pane("e"), f: pane("f"), g: pane("g"), x: pane("x", "/bin/zsh"),
      },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    expect(result.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
    expect(result.panes.x.shellType).toBe("/bin/zsh");
    expect(result.activeTabId).toBe("tab-3");
  });

  it("drops a tab only when all its panes were explicitly closed", () => {
    const base = baseline7();
    // User closed the entire single-pane Tab 1 (pane a tombstoned). Runtime
    // no longer has tab-1.
    const runtime = ws({
      activeTabId: "tab-2",
      tabs: [
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "c", "d", "e", "f", "g"], layoutPreset: "grid-3x2" },
      ],
      panes: { b: pane("b"), c: pane("c"), d: pane("d"), e: pane("e"), f: pane("f"), g: pane("g") },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set(["a"]) });
    expect(result.tabs.map((t) => t.id)).toEqual(["tab-2"]);
    expect(result.panes).not.toHaveProperty("a");
  });

  it("preserves a whole tab that failed to restore (no panes tombstoned)", () => {
    const base = baseline7();
    // tab-2 entirely failed to spawn; runtime only has tab-1.
    const runtime = ws({
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" }],
      panes: { a: pane("a") },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    const tab2 = result.tabs.find((t) => t.id === "tab-2");
    expect(tab2?.paneStableIds).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("carries over baseline edge offsets for preserved panes", () => {
    const base = baseline7();
    base.edgeOffsets = { d: { left: 5, top: 0, right: 0, bottom: 0 } };
    const runtime = ws({
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "c", "e", "f", "g"], layoutPreset: "grid-3x2" },
      ],
      panes: { a: pane("a"), b: pane("b"), c: pane("c"), e: pane("e"), f: pane("f"), g: pane("g") },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    expect(result.edgeOffsets.d).toEqual({ left: 5, top: 0, right: 0, bottom: 0 });
  });

  it("does not duplicate a pane that moved to another tab (break-out)", () => {
    const base = baseline7();
    // User broke pane "g" out of Grid 2 into a brand-new tab-3. It's alive,
    // just in a different tab — it must NOT be re-added to Grid 2.
    const runtime = ws({
      activeTabId: "tab-3",
      tabs: [
        { id: "tab-1", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" },
        { id: "tab-2", name: "Grid 2", paneStableIds: ["b", "c", "d", "e", "f"], layoutPreset: "grid-3x2" },
        { id: "tab-3", name: "g", paneStableIds: ["g"], layoutPreset: "auto" },
      ],
      panes: {
        a: pane("a"), b: pane("b"), c: pane("c"), d: pane("d"),
        e: pane("e"), f: pane("f"), g: pane("g"),
      },
    });
    const result = reconcileWorkspace({ runtime, baseline: base, tombstones: new Set() });
    expect(result.tabs.find((t) => t.id === "tab-2")?.paneStableIds).toEqual(["b", "c", "d", "e", "f"]);
    expect(result.tabs.find((t) => t.id === "tab-3")?.paneStableIds).toEqual(["g"]);
    // "g" appears exactly once across the whole workspace.
    const all = result.tabs.flatMap((t) => t.paneStableIds);
    expect(all.filter((s) => s === "g")).toHaveLength(1);
  });

  it("handles an empty baseline (first run) by just using runtime", () => {
    const runtime = ws({
      activeTabId: "tab-0",
      tabs: [{ id: "tab-0", name: "Tab 1", paneStableIds: ["a"], layoutPreset: "auto" }],
      panes: { a: pane("a") },
    });
    const result = reconcileWorkspace({
      runtime,
      baseline: ws({}),
      tombstones: new Set(),
    });
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].paneStableIds).toEqual(["a"]);
  });
});
