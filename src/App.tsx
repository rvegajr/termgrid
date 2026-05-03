import { createSignal, createMemo, onMount, For, createEffect, Show } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "./services/tauri-ipc";
import {
  calculateLayoutPreset,
  type LayoutPreset,
} from "./services/layout-engine";
import { TitleBar } from "./components/TitleBar";
import { HelpTip } from "./components/HelpTip";
import {
  ResizablePane,
  ZERO_OFFSETS,
  type EdgeOffsets,
} from "./components/ResizablePane";
import {
  activeSession,
  updateLocalSession,
  broadcastOutput,
  broadcastPanes,
  remoteSessions,
} from "./services/relay";
import { RemoteViewer } from "./components/RemoteViewer";
import { terminalPrefs, fontStack } from "./services/terminal-prefs";
import {
  loadWorkspace,
  saveWorkspace,
  newStableId,
  type Workspace,
} from "./services/workspace";
import {
  attachSnapshot,
  restoreSnapshot,
  rememberPaneId,
  forgetPaneId,
  type SnapshotHandle,
} from "./services/pane-snapshot";
import { attachMeta, detachMeta, feedRaw } from "./services/pane-meta";
import { attachRecorder, detachRecorder, feedHistoryRaw } from "./services/history";
import { PaneLabel } from "./components/PaneLabel";
import { HistoryPanel } from "./components/HistoryPanel";
import { localPeerId } from "./services/relay";
import "./App.css";

interface PaneState {
  id: string;          // runtime UI id, regenerated each launch
  stableId: string;    // persistent id — keys snapshots + workspace
  backendId: string;   // PTY id from Rust, rotates each launch
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  shellType: string;
  snapshot: SnapshotHandle;
}

interface TabState {
  id: string;
  name: string;
  paneIds: string[];
}

let nextPaneId = 0;
let nextTabId = 0;

function App() {
  const [panes, setPanes] = createSignal<PaneState[]>([]);
  const [tabs, setTabs] = createSignal<TabState[]>([]);
  const [activeTabId, setActiveTabId] = createSignal<string | null>(null);
  const [zoomedPaneId, setZoomedPaneId] = createSignal<string | null>(null);
  const [shells, setShells] = createSignal<ipc.ShellInfo[]>([]);
  const [defaultShellInfo, setDefaultShellInfo] = createSignal<ipc.ShellInfo | null>(null);
  const [layoutPreset, setLayoutPreset] = createSignal<LayoutPreset>("auto");
  const [edgeOffsets, setEdgeOffsets] = createSignal<Record<string, EdgeOffsets>>({});
  const [showAddMenu, setShowAddMenu] = createSignal(false);
  const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
  const [showHistory, setShowHistory] = createSignal(false);
  let tilingRef: HTMLDivElement | undefined;

  function updateOffsets(id: string, next: EdgeOffsets) {
    setEdgeOffsets((prev) => ({ ...prev, [id]: next }));
  }
  function resetEdge(id: string, edge: keyof EdgeOffsets) {
    setEdgeOffsets((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? ZERO_OFFSETS), [edge]: 0 },
    }));
  }
  function resetAllOffsets() {
    setEdgeOffsets({});
  }

  onMount(async () => {
    const [availableShells, dflt] = await Promise.all([
      ipc.listShells(),
      ipc.defaultShell().catch(() => null),
    ]);
    setShells(availableShells);
    setDefaultShellInfo(dflt);

    // Listen for PTY output FIRST — must be attached before any pane spawns,
    // otherwise the initial shell prompt is emitted with no listener and lost.
    await listen<{ pane_id: string; data: number[] }>("pty-output", (event) => {
      const pane = panes().find(p => p.backendId === event.payload.pane_id);
      if (pane) {
        const bytes = new Uint8Array(event.payload.data);
        feedRaw(pane.backendId, bytes);
        try {
          feedHistoryRaw(pane.backendId, new TextDecoder("utf-8", { fatal: false }).decode(bytes));
        } catch {}
        pane.terminal.write(bytes);
        // Mirror to any linked peer that's watching us
        broadcastOutput(pane.backendId, bytes);
      }
    });

    // Hydrate from saved workspace if one exists; otherwise show start screen.
    const ws = loadWorkspace();
    if (ws.tabs.length > 0) {
      await hydrateWorkspace(ws);
    }

    // Keybindings
    document.addEventListener("keydown", handleKeyDown);

    // Close add-menu on outside click
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".tab-add-wrap")) {
        setShowAddMenu(false);
      }
    });

    // Best-effort: flush pending scrollback before window closes.
    window.addEventListener("beforeunload", () => {
      for (const p of panes()) p.snapshot.flush();
    });
  });

  function handleKeyDown(e: KeyboardEvent) {
    // Ctrl+N: new pane in active tab
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      addPaneToActiveTab();
    }
    // Ctrl+T: new tab with new pane
    if (e.ctrlKey && e.key === "t") {
      e.preventDefault();
      addPaneToNewTab();
    }
    // Ctrl+W: close active pane
    if (e.ctrlKey && e.key === "w") {
      e.preventDefault();
      closeActivePane();
    }
    // Ctrl+R: open command history
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      setShowHistory(prev => !prev);
    }
  }

  async function createPaneState(shell?: string, opts?: { stableId?: string }): Promise<PaneState> {
    const result = await ipc.createPane(shell);
    const id = `pane-${nextPaneId++}`;
    const stableId = opts?.stableId ?? newStableId();

    const terminal = new Terminal({
      cursorBlink: terminalPrefs().cursorBlink,
      fontSize: terminalPrefs().fontSize,
      scrollback: 100_000,
      fontFamily: fontStack(),
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        cursorAccent: "#1e1e2e",
        selectionBackground: "#585b7066",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);

    // Snapshot keyed by stableId so scrollback survives PTY rotation.
    const snapshot = attachSnapshot(stableId, terminal);
    rememberPaneId(stableId);
    attachMeta(result.pane_id, terminal, shell);
    attachRecorder(result.pane_id, terminal, () => localPeerId());

    // Send input to backend
    terminal.onData((data) => {
      ipc.writePane(result.pane_id, data);
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      ipc.resizePane(result.pane_id, cols, rows);
    });

    return {
      id,
      stableId,
      backendId: result.pane_id,
      terminal,
      fitAddon,
      searchAddon,
      shellType: shell ?? "default",
      snapshot,
    };
  }

  async function hydrateWorkspace(ws: Workspace) {
    if (ws.layoutPreset) setLayoutPreset(ws.layoutPreset as LayoutPreset);
    const newTabs: TabState[] = [];
    const newPanes: PaneState[] = [];
    for (const t of ws.tabs) {
      const tabPanes: string[] = [];
      for (const sid of t.paneStableIds) {
        const meta = ws.panes[sid];
        const pane = await createPaneState(meta?.shellType, { stableId: sid });
        newPanes.push(pane);
        tabPanes.push(pane.id);
      }
      if (tabPanes.length === 0) {
        // empty tab — give it one fresh pane
        const pane = await createPaneState();
        newPanes.push(pane);
        tabPanes.push(pane.id);
      }
      newTabs.push({ id: t.id, name: t.name, paneIds: tabPanes });
      if (parseInt(t.id.replace(/\D/g, ""), 10) >= nextTabId) {
        nextTabId = parseInt(t.id.replace(/\D/g, ""), 10) + 1;
      }
    }
    setPanes(newPanes);
    setTabs(newTabs);
    const wantedActive = ws.activeTabId && newTabs.some((t) => t.id === ws.activeTabId)
      ? ws.activeTabId
      : newTabs[0]?.id ?? null;
    setActiveTabId(wantedActive);
  }

  async function addPaneToNewTab(shell?: string) {
    const pane = await createPaneState(shell);
    const tabId = `tab-${nextTabId++}`;
    const tab: TabState = {
      id: tabId,
      name: `Tab ${tabs().length + 1}`,
      paneIds: [pane.id],
    };
    setPanes(prev => [...prev, pane]);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tabId);
  }

  async function addPaneToActiveTab(shell?: string) {
    const tabId = activeTabId();
    if (!tabId) return;
    const pane = await createPaneState(shell);
    setPanes(prev => [...prev, pane]);
    setTabs(prev =>
      prev.map(t =>
        t.id === tabId ? { ...t, paneIds: [...t.paneIds, pane.id] } : t
      )
    );
  }

  async function addFourCornerLayout() {
    // Create a new tab with 4 panes in grid layout
    const pane1 = await createPaneState();
    const pane2 = await createPaneState();
    const pane3 = await createPaneState();
    const pane4 = await createPaneState();
    const tabId = `tab-${nextTabId++}`;
    const tab: TabState = {
      id: tabId,
      name: `Grid ${tabs().length + 1}`,
      paneIds: [pane1.id, pane2.id, pane3.id, pane4.id],
    };
    setPanes(prev => [...prev, pane1, pane2, pane3, pane4]);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tabId);
    setLayoutPreset("grid");
  }

  async function closeActivePane() {
    const tabId = activeTabId();
    if (!tabId) return;
    const tab = tabs().find(t => t.id === tabId);
    if (!tab || tab.paneIds.length === 0) return;

    const lastPaneId = tab.paneIds[tab.paneIds.length - 1];
    const pane = panes().find(p => p.id === lastPaneId);
    if (pane) {
      await pane.snapshot.destroy(true);
      detachMeta(pane.backendId);
      detachRecorder(pane.backendId);
      forgetPaneId(pane.stableId);
      pane.terminal.dispose();
      await ipc.closePane(pane.backendId);
      setPanes(prev => prev.filter(p => p.id !== lastPaneId));
      setTabs(prev =>
        prev.map(t =>
          t.id === tabId
            ? { ...t, paneIds: t.paneIds.filter(id => id !== lastPaneId) }
            : t
        )
      );
    }
  }

  function closeTab(tabId: string) {
    const tab = tabs().find(t => t.id === tabId);
    if (!tab) return;
    for (const paneId of tab.paneIds) {
      const pane = panes().find(p => p.id === paneId);
      if (pane) {
        pane.snapshot.destroy(true);
        detachMeta(pane.backendId);
        forgetPaneId(pane.backendId);
        pane.terminal.dispose();
        ipc.closePane(pane.backendId);
      }
    }
    setPanes(prev => prev.filter(p => !tab.paneIds.includes(p.id)));
    setTabs(prev => prev.filter(t => t.id !== tabId));
    const remaining = tabs().filter(t => t.id !== tabId);
    if (remaining.length > 0) {
      setActiveTabId(remaining[remaining.length - 1].id);
    } else {
      setActiveTabId(null);
    }
  }

  const mountedPanes = new Set<string>();

  function mountTerminal(el: HTMLDivElement, pane: PaneState) {
    if (mountedPanes.has(pane.id)) {
      // Already mounted — just refit in case container changed
      pane.fitAddon.fit();
      return;
    }

    pane.terminal.open(el);
    try {
      pane.terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, fallback to canvas
    }
    pane.fitAddon.fit();
    mountedPanes.add(pane.id);

    // Restore prior scrollback (if any) — keyed by stable id, so it
    // survives across launches even though the PTY backend id rotates.
    restoreSnapshot(pane.stableId, pane.terminal);

    // Refit on container resize
    const observer = new ResizeObserver(() => {
      pane.fitAddon.fit();
    });
    observer.observe(el);
  }

  function getActivePanes(): PaneState[] {
    const tabId = activeTabId();
    if (!tabId) return [];
    const tab = tabs().find(t => t.id === tabId);
    if (!tab) return [];
    return tab.paneIds
      .map(id => panes().find(p => p.id === id))
      .filter((p): p is PaneState => p !== undefined);
  }

  // Computed layouts for the ACTIVE tab — reactive
  const computedLayouts = createMemo(() =>
    calculateLayoutPreset(layoutPreset(), getActivePanes().length)
  );

  // Get panes for any tab (not just active)
  function getPanesForTab(tabId: string): PaneState[] {
    const tab = tabs().find(t => t.id === tabId);
    if (!tab) return [];
    return tab.paneIds
      .map(id => panes().find(p => p.id === id))
      .filter((p): p is PaneState => p !== undefined);
  }

  // Refit terminals when switching tabs (container may have resized while hidden)
  createEffect(() => {
    const tabId = activeTabId();
    if (!tabId) return;
    // Small delay to let display:block take effect before fitting
    setTimeout(() => {
      for (const pane of getActivePanes()) {
        pane.fitAddon.fit();
      }
    }, 50);
  });

  // Snap back when layout preset changes
  createEffect(() => {
    layoutPreset();
    resetAllOffsets();
  });

  // Keep session-manager pane count in sync
  createEffect(() => {
    updateLocalSession({ paneCount: getActivePanes().length });
  });

  // Persist workspace whenever its shape changes (debounced inside saveWorkspace)
  createEffect(() => {
    const ts = tabs();
    const ps = panes();
    const ws: Workspace = {
      tabs: ts.map((t) => ({
        id: t.id,
        name: t.name,
        paneStableIds: t.paneIds
          .map((pid) => ps.find((p) => p.id === pid)?.stableId)
          .filter((x): x is string => !!x),
      })),
      activeTabId: activeTabId(),
      panes: Object.fromEntries(
        ps.map((p) => [p.stableId, { stableId: p.stableId, shellType: p.shellType }]),
      ),
      layoutPreset: layoutPreset(),
    };
    saveWorkspace(ws);
  });

  // Live-update font/size on all panes when prefs change
  createEffect(() => {
    const p = terminalPrefs();
    const ff = fontStack(p);
    for (const pane of panes()) {
      pane.terminal.options.fontFamily = ff;
      pane.terminal.options.fontSize = p.fontSize;
      pane.terminal.options.cursorBlink = p.cursorBlink;
      try { pane.fitAddon.fit(); } catch {}
    }
  });

  // Advertise the active tab's pane descriptors to linked peers
  createEffect(() => {
    const list = getActivePanes().map((p) => ({
      paneId: p.backendId,
      label: p.shellType,
    }));
    broadcastPanes(list);
  });

  return (
    <div class="termgrid">
      <TitleBar layout={layoutPreset()} onLayoutChange={setLayoutPreset} />

      {/* Tab Bar */}
      <div class="tab-bar">
        <For each={tabs()}>
          {(tab) => (
            <HelpTip
              title={tab.name}
              description={`Click to switch to this tab. Contains ${tab.paneIds.length} pane(s). Right-click for rename / color (coming soon).`}
              badge={false}
            >
              <div
                class={`tab ${tab.id === activeTabId() ? "active" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span class="tab-name">{tab.name}</span>
                <span class="tab-count">({tab.paneIds.length})</span>
                <HelpTip
                  title="Close tab"
                  description="Closes this tab and disposes all its panes. Cannot be undone."
                  badge={false}
                >
                  <button
                    class="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    x
                  </button>
                </HelpTip>
              </div>
            </HelpTip>
          )}
        </For>
        <div class="tab-add-wrap">
          <button
            class="tab-new"
            onClick={() => setShowAddMenu(prev => !prev)}
            title="New tab / split / 4-corner layout"
          >
            +
          </button>
          {showAddMenu() && (
            <div class="add-menu">
              <button
                class="add-menu-item"
                title="Create a new tab with one fresh terminal pane (Ctrl+T)"
                onClick={() => { addPaneToNewTab(); setShowAddMenu(false); }}
              >
                <span class="add-icon">+</span> New Tab
                <span class="add-shortcut">⌃T</span>
              </button>
              <button
                class="add-menu-item"
                title="Add a pane inside the current tab — auto-tiles with existing panes (Ctrl+N)"
                onClick={() => { addPaneToActiveTab(); setShowAddMenu(false); }}
              >
                <span class="add-icon">&#9638;</span> New Pane (split)
                <span class="add-shortcut">⌃N</span>
              </button>
              <button
                class="add-menu-item"
                title="Add enough panes to fill a 2×2 grid in the current tab"
                onClick={() => { addFourCornerLayout(); setShowAddMenu(false); }}
              >
                <span class="add-icon">&#9638;&#9638;</span> 4-Corner Layout
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Remote viewer — shown when active session is a peer */}
      {(() => {
        const remoteId = () => {
          const id = activeSession();
          const s = remoteSessions().find((r) => r.id === id);
          return s && !s.isLocal ? id : null;
        };
        return (
          <Show when={remoteId()}>
            <div class="remote-banner">
              viewing <b>{remoteSessions().find(r => r.id === activeSession())?.name}</b> · read-only mirror
            </div>
            <div class="tiling-container remote-mode">
              <RemoteViewer peerId={remoteId()!} layout={layoutPreset()} />
            </div>
          </Show>
        );
      })()}

      {/* Tiling Container — renders ALL tabs, hides inactive ones */}
      <div
        class="tiling-container"
        classList={{ hidden: (() => {
          const s = remoteSessions().find(r => r.id === activeSession());
          return !!s && !s.isLocal;
        })() }}
        ref={tilingRef}
        onDblClick={resetAllOffsets}
      >
        <Show when={tabs().length === 0}>
          <div class="welcome">
            <div class="welcome-card">
              <div class="welcome-logo">▦</div>
              <div class="welcome-title">TermGrid</div>
              <div class="welcome-sub">Start a session to begin.</div>

              <div class="welcome-shells">
                {(() => {
                  const dflt = defaultShellInfo();
                  const list = shells();
                  const isDefault = (s: ipc.ShellInfo) =>
                    !!dflt && (s.path === dflt.path || s.name === dflt.name);
                  const sorted = [...list].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
                  if (sorted.length === 0 && dflt) sorted.push(dflt);
                  return (
                    <For each={sorted}>
                      {(s) => {
                        const isMacBash = s.path === "/bin/bash" && /Mac/i.test(navigator.userAgent);
                        return (
                          <button
                            class={`welcome-shell-btn ${isDefault(s) ? "default" : ""} ${isMacBash ? "warn" : ""}`}
                            onClick={() => addPaneToNewTab(s.path)}
                            title={isMacBash
                              ? "macOS ships an old bash 3.2 that prints a deprecation warning on launch — pick zsh instead."
                              : s.path}
                          >
                            <Show when={isDefault(s)}>
                              <span class="ws-default-tag">DEFAULT</span>
                            </Show>
                            <Show when={isMacBash}>
                              <span class="ws-warn-tag">OLD</span>
                            </Show>
                            <span class="ws-name">{s.name}</span>
                            <span class="ws-kind">{s.path}</span>
                          </button>
                        );
                      }}
                    </For>
                  );
                })()}
                <Show when={shells().length === 0 && !defaultShellInfo()}>
                  <button class="welcome-shell-btn" onClick={() => addPaneToNewTab()}>
                    <span class="ws-name">Default shell</span>
                  </button>
                </Show>
              </div>

              <div class="welcome-tips">
                <kbd>Ctrl+T</kbd> new tab · <kbd>Ctrl+N</kbd> split · <kbd>Ctrl+R</kbd> history
              </div>
            </div>
          </div>
        </Show>
        <For each={tabs()}>
          {(tab) => {
            const isActive = () => tab.id === activeTabId();
            const tabPanes = () => getPanesForTab(tab.id);
            const tabLayouts = () =>
              isActive()
                ? computedLayouts()
                : calculateLayoutPreset(layoutPreset(), tabPanes().length);

            return (
              <div
                class={`tab-layer ${isActive() ? "tab-layer-active" : "tab-layer-hidden"}`}
              >
                <For each={tabPanes()}>
                  {(pane, index) => (
                    <ResizablePane
                      paneId={pane.id}
                      base={() => tabLayouts()[index()] ?? { paneId: pane.id, x: 0, y: 0, width: 100, height: 100 }}
                      offsets={() => edgeOffsets()[pane.id] ?? ZERO_OFFSETS}
                      container={() => tilingRef}
                      onOffsetsChange={updateOffsets}
                      onResetEdge={resetEdge}
                    >
                      <div
                        class="pane-body"
                        onPointerDown={() => setFocusedPaneId(pane.id)}
                        ref={(el) => {
                          requestAnimationFrame(() => mountTerminal(el, pane));
                        }}
                      />
                      <PaneLabel
                        paneId={pane.backendId}
                        shellHint={pane.shellType}
                        focused={() => focusedPaneId() === pane.id}
                      />
                    </ResizablePane>
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </div>

      {/* Status Bar */}
      <div class="status-bar">
        <span>{getActivePanes().length} pane(s)</span>
        <span>|</span>
        <span>Ctrl+N: new pane</span>
        <span>|</span>
        <span>Ctrl+T: new tab</span>
        <span>|</span>
        <span>Ctrl+W: close pane</span>
        <span>|</span>
        <span>session: {activeSession()}</span>
        <span>|</span>
        <span>layout: {layoutPreset()}</span>
        <span>|</span>
        <span>dbl-click edge/bg to snap back</span>
        <span>|</span>
        <span>Ctrl+R: history</span>
      </div>

      <HistoryPanel
        paneId={(() => {
          const fid = focusedPaneId();
          if (!fid) return null;
          return panes().find(p => p.id === fid)?.backendId ?? null;
        })()}
        open={showHistory()}
        onClose={() => setShowHistory(false)}
        onPick={(cmd) => {
          const fid = focusedPaneId();
          const pane = panes().find(p => p.id === fid);
          if (pane) ipc.writePane(pane.backendId, cmd);
        }}
      />
    </div>
  );
}

export default App;
