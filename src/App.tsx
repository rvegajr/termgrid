import { createSignal, createMemo, onMount, For, Index, createEffect, Show, batch, createRoot } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { quoteShellPath, quoteShellPaths, findElementAtPoint } from "./services/pane-drop";
import { loadTerminalModules, prefetchTerminalModules } from "./services/terminal-loader";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
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
  b64ToBytes,
} from "./services/relay";
import { RemoteViewer } from "./components/RemoteViewer";
import { terminalPrefs, fontStack, loadCachedCellDimensions, saveCellDimensions } from "./services/terminal-prefs";
import {
  loadWorkspace,
  saveWorkspace,
  newStableId,
  hasSavedWorkspace,
  type Workspace,
} from "./services/workspace";
import { reconcileWorkspace } from "./services/workspace-reconcile";
import * as mruShell from "./services/mru-shell";
import { defaultShell, setDefaultShell } from "./services/default-shell";
import * as recentCwds from "./services/recent-cwds";
import { getTabIcon } from "./services/tab-icons";
import {
  installDeepLinkHandler,
  onOpenRequest,
  type OpenRequest,
} from "./services/deep-link";
import {
  attachSnapshot,
  restoreSnapshot,
  rememberPaneId,
  purgeOrphanSnapshots,
  type SnapshotHandle,
} from "./services/pane-snapshot";
import { attachMeta, feedRaw, paneMetaMap, decodePtyChunk } from "./services/pane-meta";
import { findPaneIdByCwd } from "./services/dir-match";
import { refreshPaneHost, refreshPaneHostsBatch } from "./services/pane-host";
import { disposePaneResources } from "./services/pane-lifecycle";
import { deriveAutoTabName } from "./services/tab-naming";
import { attachRecorder, feedHistoryRaw } from "./services/history";
import { PaneLabel } from "./components/PaneLabel";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { AdoptionPicker } from "./components/AdoptionPicker";
import * as adoption from "./services/adoption";
import * as adoptionMemory from "./services/adoption-memory";
import { GlobalSearch } from "./components/GlobalSearch";
import { TemplateManager } from "./components/TemplateManager";
import * as sessionTemplates from "./services/session-templates";
import * as themes from "./services/themes";
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
  shouldRestoreSnapshot: boolean; // false for brand-new panes, true for hydrated ones
  resizeObserver?: ResizeObserver; // connected in mountTerminal, disconnected in disposePaneResources
}

interface TabState {
  id: string;
  name: string;
  paneIds: string[];
}

let nextPaneId = 0;
let nextTabId = 0;

/**
 * The workspace loaded at launch — captured before hydration so the persist
 * effect can guarantee a restore hiccup never deletes tabs/panes the user
 * didn't close. See services/workspace-reconcile.ts.
 */
let restoreBaseline: Workspace = {
  tabs: [],
  activeTabId: null,
  panes: {},
  edgeOffsets: {},
  defaultLayoutPreset: "auto",
};

/**
 * stableIds the user has explicitly closed this session. Only these authorize
 * removing a pane from the persisted workspace; anything else missing from
 * runtime is treated as "failed to restore" and is preserved for next launch.
 */
const closedStableIds = new Set<string>();

function App() {
  const [panes, setPanes] = createSignal<PaneState[]>([]);
  const [tabs, setTabs] = createSignal<TabState[]>([]);
  const [activeTabId, setActiveTabId] = createSignal<string | null>(null);
  const [shells, setShells] = createSignal<ipc.ShellInfo[]>([]);
  const [defaultShellInfo, setDefaultShellInfo] = createSignal<ipc.ShellInfo | null>(null);
  // Panes whose shells have exited naturally (tombstoned - scrollback preserved, polling stops)
  const [exitedPaneIds, setExitedPaneIds] = createSignal<Set<string>>(new Set());
  // Per-tab layout preset. The TitleBar shows the active tab's preset and
  // changing it only affects that tab. New tabs default to "auto".
  const [tabLayouts, setTabLayouts] = createSignal<Record<string, LayoutPreset>>({});
  
  // Memoized pane lookup map for O(1) access in hot paths (pty-output listener)
  const paneIndex = createMemo(() => {
    const m = new Map<string, PaneState>();
    for (const p of panes()) m.set(p.backendId, p);
    return m;
  });
  const layoutPreset = (): LayoutPreset => {
    const t = activeTabId();
    return (t && tabLayouts()[t]) || "auto";
  };
  /** Send `cd <path>\n` to a pane, with shell-safe single-quote escaping. */
  function cdPaneTo(backendId: string, path: string) {
    const escaped = path.replace(/'/g, `'\\''`);
    ipc.writePane(backendId, `cd '${escaped}'\n`);
  }

  /** Handle `termgrid://open?path=...&mode=...` requests from the OS. */
  async function handleOpenRequest(req: OpenRequest) {
    // Intelligent reuse: focus an already-open pane for this folder.
    const entries = panes().map(p => ({ paneId: p.id, cwd: paneMetaMap()[p.backendId]?.cwd }));
    const existingId = findPaneIdByCwd(req.path, entries);
    if (existingId) {
      const tab = tabs().find(t => t.paneIds.includes(existingId));
      if (tab) setActiveTabId(tab.id);
      setFocusedPaneId(existingId);
      try { panes().find(p => p.id === existingId)?.terminal.focus(); } catch {}
      return;
    }

    if (req.mode === "new-tab") {
      const pane = await createPaneState();
      const tabId = `tab-${nextTabId++}`;
      const tab: TabState = {
        id: tabId,
        name: pathBaseName(req.path) || `Tab ${tabs().length + 1}`,
        paneIds: [pane.id],
      };
      batch(() => {
        setPanes(prev => [...prev, pane]);
        setTabs(prev => [...prev, tab]);
        setActiveTabId(tabId);
      });
      // Wait for the shell to print its first prompt before sending cd.
      setTimeout(() => cdPaneTo(pane.backendId, req.path), 600);
      return;
    }

    if (req.mode === "existing") {
      const fid = focusedPaneId();
      const pane = (fid && panes().find(p => p.id === fid)) || getActivePanes()[0];
      if (pane) {
        cdPaneTo(pane.backendId, req.path);
      } else {
        // No pane yet (welcome screen) — fall through to spawn one.
        await addPaneToActiveTab();
        const last = panes()[panes().length - 1];
        if (last) setTimeout(() => cdPaneTo(last.backendId, req.path), 600);
      }
      return;
    }

    // mode: "unused" — pick an empty/idle pane in the active tab if any,
    // otherwise spawn a new pane in the active tab.
    if (req.mode === "unused") {
      if (!activeTabId()) {
        // No tabs — make one.
        await addPaneToNewTab();
      } else {
        await addPaneToActiveTab();
      }
      const last = panes()[panes().length - 1];
      if (last) setTimeout(() => cdPaneTo(last.backendId, req.path), 600);
    }
  }

  function pathBaseName(p: string): string {
    const trimmed = p.replace(/[/\\]+$/, "");
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }

  /**
   * Auto-name a tab from its first pane's CWD.
   * Subscribes once to paneMetaMap, sets tab.name when CWD resolves,
   * then unsubscribes. Skips if the user manually edited the name.
   */
  function autoNameTabFromCwd(tabId: string, paneBackendId: string) {
    let hasNamed = false;
    
    // Wrap effect in createRoot so it can be disposed (prevents leak)
    createRoot((dispose) => {
      createEffect(() => {
        if (hasNamed) {
          // Named once, tear down the effect
          dispose();
          return;
        }
        
        const meta = paneMetaMap()[paneBackendId];
        const tab = tabs().find(t => t.id === tabId);
        
        // Tab is gone, tear down
        if (!tab) {
          hasNamed = true;
          dispose();
          return;
        }
        
        const tabNumber = tabs().findIndex(t => t.id === tabId) + 1;
        const newName = deriveAutoTabName(meta, tab.name, tabNumber);
        
        // No name derived yet, keep waiting
        if (newName === null) return;
        
        // Apply the name
        setTabs(prev =>
          prev.map(t =>
            t.id === tabId ? { ...t, name: newName } : t
          )
        );
        
        // Mark as named and tear down
        hasNamed = true;
        dispose();
      });
    });
  }

  function setLayoutPreset(preset: LayoutPreset) {
    const t = activeTabId();
    if (!t) return;
    setTabLayouts((prev) => ({ ...prev, [t]: preset }));
    // Manual layout change resets the active tab's edge overrides — matches
    // the prior single-layout behavior. Tab-switching does NOT reset.
    resetAllOffsets();
  }
  const [edgeOffsets, setEdgeOffsets] = createSignal<Record<string, EdgeOffsets>>({});
  const [showAddMenu, setShowAddMenu] = createSignal(false);
  const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
  const [showHistory, setShowHistory] = createSignal(false);
  // Gate the persist effect — true only after the initial hydrate completes
  // (or after the welcome screen lands the first pane). Without this, the
  // first effect run fires against empty signals and clobbers the saved
  // workspace before hydrate finishes its async pane spawns.
  const [hydrated, setHydrated] = createSignal(false);
  let tilingRef: HTMLDivElement | undefined;
  // PTY output listener setup promise — createPaneState awaits this before spawning.
  let ptyListenerReady: Promise<void> | null = null;
  // Terminal cell dimensions (measured once at startup, updated on font change).
  const [cellDimensions, setCellDimensions] = createSignal<{ width: number; height: number } | null>(null);
  // Most recently used shell (sorts the empty-tab shell picker)
  const [mruShellPath, setMruShellPath] = createSignal<string | null>(null);
  const [welcomeShellIndex, setWelcomeShellIndex] = createSignal(0);
  const [draggedTabId, setDraggedTabId] = createSignal<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = createSignal<string | null>(null);
  // Tab right-click menu for setting the global default shell. Null = closed.
  const [tabMenuPos, setTabMenuPos] = createSignal<{ x: number; y: number } | null>(null);
  // (drag-to-pane adoption monitor was explored in v5 but removed — the UX
  //  never landed cleanly. Use "Snap to Frontmost Terminal" (Ctrl+Shift+Alt+A)
  //  or the regular adoption picker instead.)
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [showAdoptionPicker, setShowAdoptionPicker] = createSignal(false);
  const [adoptionParentFilter, setAdoptionParentFilter] = createSignal<string | null>(null);
  const [showGlobalSearch, setShowGlobalSearch] = createSignal(false);
  const [showTemplateManager, setShowTemplateManager] = createSignal(false);
  const [currentTheme, setCurrentTheme] = createSignal<themes.TerminalTheme>(themes.BUILT_IN_THEMES[0]);
  const [showThemePicker, setShowThemePicker] = createSignal(false);

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
    // Only reset the active tab's panes — leave other tabs' overrides intact.
    const activePaneIds = new Set(getActivePanes().map((p) => p.id));
    if (activePaneIds.size === 0) {
      setEdgeOffsets({});
      return;
    }
    setEdgeOffsets((prev) => {
      const next = { ...prev };
      for (const id of activePaneIds) delete next[id];
      return next;
    });
  }

  onMount(async () => {
    // Remove splash screen now that SolidJS has mounted
    const splash = document.getElementById("splash");
    if (splash) splash.remove();

    // Load cached cell dimensions for faster PTY sizing
    const cachedDims = await loadCachedCellDimensions();
    if (cachedDims) {
      setCellDimensions(cachedDims);
    }

    // Load MRU shell — sorts the empty-tab shell picker.
    const mru = await mruShell.getMruShell();
    if (mru) {
      setMruShellPath(mru.path);
    }

    // Load selected theme
    const theme = await themes.getSelectedTheme();
    setCurrentTheme(theme);

    // Single IPC with caching — detects shells once, avoids double $PATH walk.
    const shellsData = await ipc.listShellsWithDefault();
    setShells(shellsData.shells);
    setDefaultShellInfo(shellsData.default);

    // Set up PTY output listener in parallel — createPaneState will await this
    // before spawning, but we don't block the welcome card on it.
    ptyListenerReady = listen<{ pane_id: string; data: string }>("pty-output", (event) => {
      const pane = paneIndex().get(event.payload.pane_id);
      if (pane) {
        // Decode base64 to bytes (~3x smaller payload vs JSON number array)
        const bytes = b64ToBytes(event.payload.data);
        // Decode once and pass the text to all consumers (avoids double decode + allocation)
        const text = decodePtyChunk(bytes);
        feedRaw(pane.backendId, bytes, text);
        try {
          feedHistoryRaw(pane.backendId, text);
        } catch {}
        pane.terminal.write(bytes);
        // Mirror to any linked peer that's watching us
        broadcastOutput(pane.backendId, bytes);
      }
    }).then(() => {});

    // Set up PTY exit listener — fires when a shell exits naturally (not via explicit kill)
    listen<{ pane_id: string }>("pty-exit", (event) => {
      const pane = paneIndex().get(event.payload.pane_id);
      if (!pane) return;
      
      // Mark as exited (idempotent)
      setExitedPaneIds(prev => {
        const newSet = new Set(prev);
        newSet.add(pane.backendId);
        return newSet;
      });
      
      // Write dim marker to terminal
      pane.terminal.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      
      // Flush final snapshot
      pane.snapshot.flush().catch(e => console.warn("[pty-exit] snapshot flush failed:", e));
    });

    // Auto-restore the previous workspace on launch — the last thing each
    // tab was left with is what it opens with. If there's nothing to
    // restore (first run, or every tab was left empty), open a single
    // empty tab that shows the shell picker.
    //
    // Capture the on-disk workspace as the reconcile baseline FIRST, before we
    // touch any runtime signal. The persist effect merges runtime against this
    // baseline so an incomplete restore can never overwrite/shrink the saved
    // session (see services/workspace-reconcile.ts).
    restoreBaseline = loadWorkspace();
    try {
      if (hasSavedWorkspace()) {
        await hydrateWorkspace(restoreBaseline);
      }
    } catch (err) {
      console.error("Workspace restore failed:", err);
    }
    // If restore produced no tabs (nothing saved, or it failed), fall back to
    // a single empty shell-picker tab. Always enable persistence afterward —
    // never leave the app unable to save because restore hiccuped.
    if (tabs().length === 0) {
      openEmptyTab();
    }
    setHydrated(true);

    // Garbage-collect snapshot files left behind by closed panes / old
    // sessions. Keep anything the saved workspace still references (those may
    // get restored or preserved by reconcile); drop the rest. Best-effort,
    // runs off the critical path.
    Promise.resolve().then(() =>
      purgeOrphanSnapshots(new Set(Object.keys(restoreBaseline.panes))),
    );

    // Wire up `termgrid://` deep-links in the background — delivery is rare
    // and tolerates a small delay. Don't block welcome on it.
    onOpenRequest(handleOpenRequest);
    Promise.resolve().then(() => installDeepLinkHandler());

    // Keybindings
    document.addEventListener("keydown", handleKeyDown);

    // Close add-menu on outside click
    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".tab-add-wrap")) {
        setShowAddMenu(false);
      }
    });

    // Flush pending scrollback on close/reload. We do NOT intercept the native
    // window close (no onCloseRequested / preventDefault) — that is what kept
    // the X button from working. beforeunload fires on window close and reload;
    // the flush is best-effort, kept current by the short snapshot debounce.
    window.addEventListener("beforeunload", () => {
      for (const p of panes()) p.snapshot.flush();
    });

    // Per-pane "where am I" poller. Cheap — one sysinfo refresh + optional
    // `ps -o args=` per ssh hit. Runs every 3s; we get an extra refresh
    // right after spawn (`createPaneState`) so the first paint isn't blank.
    // Uses batched IPC to scan process tree once instead of per-pane.
    setInterval(() => {
      const exited = exitedPaneIds();
      const activePanes = panes().filter(p => !exited.has(p.backendId));
      const paneIds = activePanes.map(p => p.backendId);
      if (paneIds.length > 0) {
        refreshPaneHostsBatch(paneIds).catch(() => {});
      }
    }, 3000);

    // File / folder drops. Tauri intercepts OS file drags before the
    // webview sees them, so we use its dedicated event instead of HTML5
    // drop. Payload gives us absolute paths plus the drop position; we
    // hit-test against pane DOM rects to route the paste to the right
    // pane. Falls through silently if the drop landed outside any pane.
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;
      const candidates = Array.from(paneEls.entries()).map(
        ([backendId, el]) => ({ el, payload: backendId }),
      );
      const backendId = findElementAtPoint(
        position.x,
        position.y,
        candidates,
      );
      if (!backendId) return;
      // Match iTerm2 / Terminal.app: paste the path(s), do NOT execute.
      // Leading space so the dropped path appends cleanly after whatever
      // the user already typed on the prompt line.
      const text = (paths.length === 1 ? quoteShellPath(paths[0]) : quoteShellPaths(paths));
      ipc.writePane(backendId, " " + text);
    });
  });

  function handleKeyDown(e: KeyboardEvent) {
    // Ctrl+N: new pane in active tab
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      addPaneToActiveTab();
    }
    // Ctrl+T: new tab — opens the shell picker, user chooses what to launch
    if (e.ctrlKey && e.key === "t") {
      e.preventDefault();
      openEmptyTab();
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
    // Ctrl+P: open command palette
    if (e.ctrlKey && e.key === "p") {
      e.preventDefault();
      setShowCommandPalette(prev => !prev);
    }
    // Ctrl+F: global search
    if (e.ctrlKey && e.key === "f") {
      e.preventDefault();
      setShowGlobalSearch(prev => !prev);
    }
    // Ctrl+S: session templates
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      setShowTemplateManager(prev => !prev);
    }
    // Ctrl+Shift+A: adopt session picker.
    // Ctrl+Shift+Alt+A (v4): "snap to frontmost" — one-shot adoption.
    if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      if (e.altKey) {
        snapToFrontmost();
      } else {
        setShowAdoptionPicker((prev) => !prev);
      }
    }
  }

  /**
   * Pull a discovered external shell into a new TermGrid pane.
   *
   * v3 contract:
   *  - `mode` — `"new-tab"` (default), `"active-pane"` (cd the focused
   *    pane), or `"split"` (add to active tab).
   *  - `strategy` — `"local-cwd"` (v1 cd-based) or `"ssh-reconnect"`
   *    (run `ssh user@host` so the user resumes the *remote* shell).
   *  - `snapshot` — may be pre-fetched by the picker. `null` means fetch.
   *  - `options.injectHistory` — when true, write each `recent_history`
   *    line into the new PTY (as comments) so TermGrid's Ctrl-R recall
   *    surfaces them. Opt-in because it pollutes the local history.
   *  - `options.forwardEnvOverSsh` — when reconnecting via SSH, append
   *    `-o SendEnv=NAME` flags so allow-listed env vars survive the hop.
   *
   * Every branch surfaces a `# adopted …` banner so the user sees what
   * happened, and records the adopted CWD into the recent-CWDs service
   * so the welcome-screen pinned-dir picker stays useful across days.
   */
  async function adoptSession(
    s: adoption.AdoptableSession,
    mode: adoption.AdoptionMode = "new-tab",
    strategy: adoption.AdoptionStrategy = "local-cwd",
    preloadedSnap: adoption.SessionSnapshot | null = null,
    options: { injectHistory?: boolean; forwardEnvOverSsh?: boolean } = {},
  ) {
    let snap: adoption.SessionSnapshot;
    if (preloadedSnap && preloadedSnap.pid === s.pid) {
      snap = preloadedSnap;
    } else {
      try {
        snap = await adoption.snapshotSessionCached(s.pid);
      } catch (err) {
        console.error("snapshotSession failed:", err);
        snap = {
          pid: s.pid,
          shell: s.shell,
          cwd: s.cwd,
          tty: s.tty,
          recent_history: [],
          banner: `adopted (${s.shell}, pid ${s.pid})`,
          buffer_preview: null,
          env_vars: [],
          ssh_target: null,
        };
      }
    }

    // v3: forward the adopted CWD into recent-cwds so it shows up on the
    // welcome screen. Best-effort — never blocks adoption.
    if (snap.cwd) {
      recentCwds.recordCwd(snap.cwd).catch(() => {});
    }
    // v4: log the adoption into persisted memory so the welcome screen
    // can offer "Reopen previously adopted dirs" later. We store only
    // *names* of env vars (never values) to keep the persisted blob
    // free of secrets even if the allow-list ever loosens.
    adoptionMemory.recordAdoption({
      adoptedAt: Date.now(),
      shell: snap.shell,
      cwd: snap.cwd,
      parent: s.parent,
      envNames: snap.env_vars.map((e) => e.name),
      mode,
    });

    // Build seed commands per strategy. Each command is written to the
    // PTY after the shell prompt initializes, in order.
    const seed: string[] = [`# ${snap.banner}`];
    if (strategy === "ssh-reconnect" && snap.ssh_target) {
      // Export env locally (so SendEnv has values to forward) then ssh.
      if (options.forwardEnvOverSsh) {
        for (const ev of snap.env_vars) {
          const safeValue = ev.value.replace(/'/g, "'\\''");
          seed.push(`export ${ev.name}='${safeValue}'`);
        }
      }
      const sendEnv = options.forwardEnvOverSsh
        ? snap.env_vars.map((v) => v.name)
        : [];
      seed.push(adoption.renderSshReconnect(snap.ssh_target, sendEnv));
    } else {
      // Local CWD strategy — forward toolchain env vars before any `cd`
      // so direnv/asdf-style hooks see them on first activation.
      for (const ev of snap.env_vars) {
        const safeValue = ev.value.replace(/'/g, "'\\''");
        seed.push(`export ${ev.name}='${safeValue}'`);
      }
    }

    // History injection: write each entry as a shell comment so it lands
    // in the local shell's history (Ctrl-R surfaces them) but does not
    // execute. Last 8 entries by default — enough to bridge context, not
    // so many that we drown the user's own history.
    if (options.injectHistory && snap.recent_history.length > 0) {
      for (const cmd of snap.recent_history.slice(-8)) {
        const oneLine = cmd.replace(/[\r\n]+/g, " ").trim();
        if (oneLine) seed.push(`# adopt-recall: ${oneLine}`);
      }
    }

    const cwd = strategy === "ssh-reconnect" ? undefined : snap.cwd ?? undefined;

    if (mode === "new-tab") {
      await addPaneToNewTab(undefined, cwd, seed);
      return;
    }

    if (mode === "active-pane") {
      const fid = focusedPaneId();
      const pane = panes().find((p) => p.id === fid);
      if (!pane) {
        await addPaneToNewTab(undefined, cwd, seed);
        return;
      }
      const lines = [...seed];
      if (cwd) {
        lines.unshift(`cd ${cwd}`);
      }
      for (const line of lines) {
        await ipc.writePane(pane.backendId, line + "\n");
      }
      return;
    }

    if (mode === "split") {
      const tabId = activeTabId();
      if (!tabId) {
        await addPaneToNewTab(undefined, cwd, seed);
        return;
      }
      const pane = await createPaneState(undefined, { cwd });
      setPanes((prev) => [...prev, pane]);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, paneIds: [...t.paneIds, pane.id] } : t,
        ),
      );
      setTimeout(() => {
        for (const cmd of seed) {
          ipc.writePane(pane.backendId, cmd + "\n");
        }
      }, 500);
      return;
    }
  }

  /**
   * **v3:** Open the adoption picker pre-filtered to the user's
   * currently-frontmost terminal app. If no app is detected we fall
   * back to the unfiltered picker.
   */
  async function openAdoptionPickerForFrontmost() {
    try {
      const host = await adoption.frontmostTerminalApp();
      setAdoptionParentFilter(host);
    } catch {
      setAdoptionParentFilter(null);
    }
    setShowAdoptionPicker(true);
  }

  /**
   * **v4:** "Snap to frontmost" — the practical drag-from-OS-window
   * equivalent that works without Accessibility entitlements.
   *
   * Behavior tiers (mirrors `SnapResult`):
   *   - `none` — show a toast with the reason; do nothing else.
   *   - `one` — adopt immediately into a new tab (the canonical
   *     drag-replacement intent: "I want this shell, here, now").
   *   - `multiple` — open the picker pre-filtered to the source app.
   */
  async function snapToFrontmost() {
    let res: adoption.SnapResult;
    try {
      res = await adoption.snapToFrontmost();
    } catch (err) {
      console.error("snapToFrontmost failed:", err);
      return;
    }
    if (res.kind === "none") {
      // Light-weight signal — surfaced via existing console; the picker
      // would be heavier UX than the user expects from a single hotkey.
      console.info("Snap to frontmost:", res.reason);
      return;
    }
    if (res.kind === "one") {
      adoption.rememberSnapshot(res.snapshot.pid, res.snapshot);
      await adoptSession(
        res.session,
        "new-tab",
        res.snapshot.ssh_target ? "ssh-reconnect" : "local-cwd",
        res.snapshot,
        { injectHistory: false, forwardEnvOverSsh: true },
      );
      return;
    }
    // res.kind === "multiple"
    setAdoptionParentFilter(res.host);
    setShowAdoptionPicker(true);
  }

  const saveSessionAsTemplate = async (name: string, description: string) => {
    const template: Omit<sessionTemplates.SessionTemplate, "id" | "createdAt"> = {
      name,
      description,
      tabCount: tabs().length,
      paneCount: panes().length,
      layout: {
        tabs: tabs().map((tab) => ({
          name: tab.name,
          paneCount: tab.paneIds.length,
          layoutPreset: tabLayouts()[tab.id] || "auto",
        })),
      },
    };
    await sessionTemplates.saveTemplate(template);
  };

  const loadTemplateLayout = async (template: sessionTemplates.SessionTemplate) => {
    // Clear current session
    for (const pane of panes()) {
      await disposePaneResources(pane, { paneEls, closedStableIds });
    }
    setPanes([]);
    setTabs([]);

    // Create tabs based on template
    for (const tabTemplate of template.layout.tabs) {
      const tabId = `tab-${nextTabId++}`;
      const paneStates: PaneState[] = [];

      for (let i = 0; i < tabTemplate.paneCount; i++) {
        const pane = await createPaneState();
        paneStates.push(pane);
      }

      const tab: TabState = {
        id: tabId,
        name: tabTemplate.name,
        paneIds: paneStates.map(p => p.id),
      };

      setPanes(prev => [...prev, ...paneStates]);
      setTabs(prev => [...prev, tab]);
      setTabLayouts(prev => ({ ...prev, [tabId]: tabTemplate.layoutPreset as LayoutPreset }));
    }

    if (tabs().length > 0) {
      setActiveTabId(tabs()[0].id);
    }
  };

  const paletteCommands = (): Command[] => [
    {
      id: "new-pane",
      name: "New Pane",
      description: "Add a new pane to the active tab",
      keywords: ["split", "add"],
      action: () => addPaneToActiveTab(),
    },
    {
      id: "new-tab",
      name: "New Tab",
      description: "Open a new tab and choose a shell to launch",
      keywords: ["create"],
      action: () => openEmptyTab(),
    },
    {
      id: "close-pane",
      name: "Close Active Pane",
      description: "Close the currently focused pane",
      keywords: ["remove", "delete"],
      action: () => closeActivePane(),
    },
    {
      id: "close-tab",
      name: "Close Active Tab",
      description: "Close the active tab and all its panes",
      keywords: ["remove", "delete"],
      action: () => {
        const id = activeTabId();
        if (id) closeTab(id);
      },
    },
    {
      id: "history",
      name: "Command History",
      description: "Search and execute previous commands",
      keywords: ["search", "recall"],
      action: () => setShowHistory(true),
    },
    {
      id: "reset-offsets",
      name: "Reset All Pane Edges",
      description: "Reset all pane resize offsets to default layout",
      keywords: ["layout", "restore"],
      action: () => resetAllOffsets(),
    },
    {
      id: "layout-auto",
      name: "Layout: Auto",
      description: "Set layout to auto-tiling",
      keywords: ["preset", "tiling"],
      action: () => setLayoutPreset("auto"),
    },
    {
      id: "layout-grid",
      name: "Layout: Grid",
      description: "Set layout to uniform grid",
      keywords: ["preset", "square"],
      action: () => setLayoutPreset("grid"),
    },
    {
      id: "themes",
      name: "Change Theme",
      description: "Switch terminal color theme",
      keywords: ["colors", "appearance", "style"],
      action: () => setShowThemePicker(true),
    },
    {
      id: "adopt-session",
      name: "Adopt Session\u2026",
      description: "Pull an external shell into a new TermGrid pane",
      keywords: ["import", "attach", "external", "terminal", "shell", "pid"],
      action: () => {
        setAdoptionParentFilter(null);
        setShowAdoptionPicker(true);
      },
    },
    {
      id: "adopt-frontmost",
      name: "Adopt Frontmost Terminal\u2026",
      description:
        "Open the picker pre-filtered to the currently focused terminal app",
      keywords: ["import", "frontmost", "active", "current", "focused"],
      action: () => openAdoptionPickerForFrontmost(),
    },
    {
      id: "snap-to-frontmost",
      name: "Snap to Frontmost Terminal",
      description:
        "Adopt the frontmost terminal's most recent shell into a new tab in one step",
      keywords: ["snap", "drag", "import", "frontmost", "instant"],
      action: () => snapToFrontmost(),
    },
    {
      id: "export-adoption-history",
      name: "Export Adoption History…",
      description: "Save your adoption memory to a JSON file",
      keywords: ["export", "backup", "save", "adoption", "history"],
      action: async () => {
        const ok = await adoptionMemory.exportAdoptionMemory();
        if (ok) {
          console.info("Adoption history exported successfully");
        }
      },
    },
    {
      id: "import-adoption-history",
      name: "Import Adoption History…",
      description: "Load adoption memory from a JSON file",
      keywords: ["import", "restore", "load", "adoption", "history"],
      action: async () => {
        const count = await adoptionMemory.importAdoptionMemory();
        if (count > 0) {
          console.info(`Imported ${count} adoption entries`);
        } else if (count === 0) {
          console.info("No new entries to import");
        }
      },
    },
    {
      id: "install-shell-plugins",
      name: "Install Shell Plugins…",
      description:
        "Install TermGrid shell plugins for cooperative adoption (zsh/bash/fish)",
      keywords: ["plugin", "shell", "install", "setup", "adoption", "env"],
      action: async () => {
        try {
          const result = await adoption.installShellPlugins();
          if (result.success) {
            console.info(result.instructions);
            alert(result.instructions);
          }
        } catch (err) {
          console.error("Failed to install shell plugins:", err);
          alert(`Failed to install shell plugins: ${err}`);
        }
      },
    },
    {
      id: "default-shell-system",
      name: "Set Default Shell: System default",
      description: "New tabs and panes launch the system default shell",
      keywords: ["default", "shell", "launch", "system"],
      action: () => setDefaultShell(null),
    },
    ...shells().map((s) => ({
      id: `default-shell-${s.path}`,
      name: `Set Default Shell: ${s.name}`,
      description: `New tabs and panes launch ${s.path}`,
      keywords: ["default", "shell", "launch", s.name],
      action: () => setDefaultShell(s.path),
    })),
  ];

  async function createPaneState(shell?: string, opts?: { stableId?: string; shouldRestoreSnapshot?: boolean; cwd?: string }): Promise<PaneState> {
    // Ensure the PTY output listener is ready before spawning — otherwise the
    // shell's initial prompt might be emitted with no handler and get lost.
    if (ptyListenerReady) await ptyListenerReady;
    
    // Lazy-load xterm modules (cached after first load)
    const { Terminal, FitAddon, SearchAddon, WebLinksAddon } = await loadTerminalModules();
    
    // Estimate terminal size before spawning to avoid the visible re-flow.
    // Use either measured cell dimensions or fallback to typical values.
    const cellDims = cellDimensions();
    const cellWidth = cellDims?.width ?? (terminalPrefs().fontSize * 0.6);
    const cellHeight = cellDims?.height ?? (terminalPrefs().fontSize * 1.4);
    
    // Compute container dimensions for this pane based on the current layout.
    // If no container exists yet (first pane), use a reasonable default.
    let containerWidth = 800;
    let containerHeight = 600;
    if (tilingRef) {
      const rect = tilingRef.getBoundingClientRect();
      containerWidth = rect.width;
      containerHeight = rect.height;
    }
    
    const cols = Math.max(40, Math.floor(containerWidth / cellWidth));
    const rows = Math.max(10, Math.floor(containerHeight / cellHeight));
    
    // `"default"` is a display sentinel we store in shellType (and persist)
    // to mean "system default shell" — it is NOT a real shell path. Restoring
    // a workspace passes shellType straight back in here, so we must map the
    // sentinel (and empty string) to undefined; otherwise ipc.createPane tries
    // to spawn a binary literally named "default", throws, and aborts the
    // whole restore. This is the root cause of "restore does nothing" on
    // sessions saved before per-pane shell paths were recorded.
    const requestedShell = shell && shell !== "default" ? shell : undefined;
    // Fall back to the user's global default shell when no explicit shell was
    // requested; null/undefined means "let the backend pick the system default".
    const effectiveShell = requestedShell ?? defaultShell() ?? undefined;
    const result = await ipc.createPane(effectiveShell, opts?.cwd, cols, rows);
    const id = `pane-${nextPaneId++}`;
    const stableId = opts?.stableId ?? newStableId();
    const shouldRestoreSnapshot = opts?.shouldRestoreSnapshot ?? false;

    const theme = currentTheme();
    const terminal = new Terminal({
      cursorBlink: terminalPrefs().cursorBlink,
      fontSize: terminalPrefs().fontSize,
      scrollback: terminalPrefs().scrollbackLines,
      fontFamily: fontStack(),
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        cursorAccent: theme.cursorAccent,
        selectionBackground: theme.selectionBackground,
        black: theme.black,
        red: theme.red,
        green: theme.green,
        yellow: theme.yellow,
        blue: theme.blue,
        magenta: theme.magenta,
        cyan: theme.cyan,
        white: theme.white,
        brightBlack: theme.brightBlack,
        brightRed: theme.brightRed,
        brightGreen: theme.brightGreen,
        brightYellow: theme.brightYellow,
        brightBlue: theme.brightBlue,
        brightMagenta: theme.brightMagenta,
        brightCyan: theme.brightCyan,
        brightWhite: theme.brightWhite,
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    
    // Web links addon - opens URLs in default browser
    const webLinksAddon = new WebLinksAddon(async (event: MouseEvent, uri: string) => {
      event.preventDefault();
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(uri);
      } catch (err) {
        console.error("Failed to open URL:", uri, err);
      }
    });
    
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);

    // Snapshot keyed by stableId so scrollback survives PTY rotation.
    const snapshot = attachSnapshot(stableId, terminal);
    rememberPaneId(stableId);

    // Restore prior scrollback HERE — before this pane is registered in panes()
    // and starts receiving live PTY output. Writing the saved buffer first (as a
    // single atomic write) means the freshly-spawned shell's banner appends
    // cleanly below it, instead of interleaving with the restore and corrupting
    // the cursor. A divider marks the boundary between restored history and the
    // live session.
    if (shouldRestoreSnapshot) {
      const restored = await restoreSnapshot(stableId, terminal);
      if (restored) {
        // Only add a boundary divider if the restored buffer doesn't already
        // end with one — prevents dividers stacking across restarts where no
        // new output was added since the last restore. (Box-drawing rule chars
        // don't occur in normal shell output, so this tail check is safe.)
        const tail = restored.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-200);
        if (!tail.includes("────────")) {
          terminal.write("\r\n\x1b[2m──────── restored ────────\x1b[0m\r\n");
        }
      }
    }
    attachMeta(result.pane_id, terminal, shell);
    attachRecorder(result.pane_id, terminal, () => localPeerId());
    // Eager first probe so the host badge paints with real data instead
    // of waiting up to 3s for the global poller.
    refreshPaneHost(result.pane_id).catch(() => {});

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
      shellType: effectiveShell ?? "default",
      snapshot,
      shouldRestoreSnapshot,
    };
  }

  /** Is the active tab a fresh, paneless tab (the shell-picker state)? */
  const activeTabIsEmpty = () => {
    if (tabs().length === 0) return true;
    const tab = tabs().find((t) => t.id === activeTabId());
    return !!tab && tab.paneIds.length === 0;
  };

  /**
   * Open a new tab with no pane. It renders the shell picker until the
   * user chooses a shell, at which point the pane lands in this same tab.
   */
  function openEmptyTab() {
    const tabId = `tab-${nextTabId++}`;
    const tab: TabState = {
      id: tabId,
      name: `Tab ${tabs().length + 1}`,
      paneIds: [],
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tabId);
  }

  /**
   * Launch a shell from the empty-tab picker. Lands the pane in the active
   * (empty) tab when there is one; otherwise falls back to a fresh tab.
   */
  async function launchShellInActiveTab(shell?: string) {
    const tabId = activeTabId();
    const tab = tabs().find((t) => t.id === tabId);
    if (!tabId || !tab) {
      await addPaneToNewTab(shell);
      return;
    }
    const pane = await createPaneState(shell);
    setPanes((prev) => [...prev, pane]);
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, paneIds: [...t.paneIds, pane.id] } : t)),
    );
    autoNameTabFromCwd(tabId, pane.backendId);
    if (shell) {
      mruShell.recordShellUse(shell);
      setMruShellPath(shell);
    }
  }

  async function hydrateWorkspace(ws: Workspace) {
    const newTabs: TabState[] = [];
    const newPanes: PaneState[] = [];
    const newTabLayouts: Record<string, LayoutPreset> = {};
    // Map saved edge offsets (keyed by stableId) → freshly-spawned pane.id.
    const newEdgeOffsets: Record<string, EdgeOffsets> = {};
    const fallbackLayout = (ws.defaultLayoutPreset || "auto") as LayoutPreset;

    for (const t of ws.tabs) {
      const tabPanes: string[] = [];
      for (const sid of t.paneStableIds) {
        const meta = ws.panes[sid];
        // Spawn each pane independently. If one fails (e.g. a stale shell
        // path that no longer exists), skip it rather than aborting the
        // entire restore — losing one pane is recoverable; losing the whole
        // session (and silently disabling persistence) is not.
        let pane: PaneState;
        try {
          pane = await createPaneState(meta?.shellType, { stableId: sid, shouldRestoreSnapshot: true });
        } catch (err) {
          console.error(`Failed to restore pane ${sid} (shell ${meta?.shellType ?? "default"}):`, err);
          continue;
        }
        newPanes.push(pane);
        // Register immediately so the pty-output listener can find this pane
        // when its freshly-spawned shell emits output, while later panes in the
        // workspace are still spawning. (Snapshot replay is separate.)
        setPanes(prev => [...prev, pane]);
        tabPanes.push(pane.id);
        // Translate persisted edge offsets stableId → runtime pane.id.
        const savedOffsets = ws.edgeOffsets?.[sid];
        if (savedOffsets) newEdgeOffsets[pane.id] = savedOffsets;
      }
      // A tab saved with no panes restores as an empty shell-picker tab —
      // honoring "the last thing it was left with is what it opens with".
      newTabs.push({ id: t.id, name: t.name, paneIds: tabPanes });
      newTabLayouts[t.id] = ((t.layoutPreset as LayoutPreset) ?? fallbackLayout);
      if (parseInt(t.id.replace(/\D/g, ""), 10) >= nextTabId) {
        nextTabId = parseInt(t.id.replace(/\D/g, ""), 10) + 1;
      }
    }
    const wantedActive = ws.activeTabId && newTabs.some((t) => t.id === ws.activeTabId)
      ? ws.activeTabId
      : newTabs[0]?.id ?? null;
    // Batch all signal writes so the persist effect sees the final state once,
    // not the intermediate stages where (e.g.) tabs is set but tabLayouts isn't.
    batch(() => {
      setTabs(newTabs);
      setTabLayouts(newTabLayouts);
      setEdgeOffsets(newEdgeOffsets);
      setActiveTabId(wantedActive);
    });
  }

  async function addPaneToNewTab(shell?: string, cwd?: string, profileCommands?: string[]) {
    const pane = await createPaneState(shell, { cwd });
    const tabId = `tab-${nextTabId++}`;
    const tab: TabState = {
      id: tabId,
      name: `Tab ${tabs().length + 1}`,
      paneIds: [pane.id],
    };
    setPanes(prev => [...prev, pane]);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tabId);
    
    // Auto-name tab from CWD when it's first resolved
    autoNameTabFromCwd(tabId, pane.backendId);
    
    // Execute profile commands if provided
    if (profileCommands && profileCommands.length > 0) {
      // Wait a moment for shell to initialize
      setTimeout(() => {
        for (const cmd of profileCommands) {
          ipc.writePane(pane.backendId, cmd + "\n");
        }
      }, 500);
    }
    
    // Record shell use for MRU tracking
    if (shell) {
      mruShell.recordShellUse(shell);
      setMruShellPath(shell);
    }
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
    
    // Record shell use for MRU tracking
    if (shell) {
      mruShell.recordShellUse(shell);
      setMruShellPath(shell);
    }
  }

  async function addGridTab(paneCount: number, preset: LayoutPreset, label: string) {
    const newPanes: PaneState[] = [];
    for (let i = 0; i < paneCount; i++) {
      const pane = await createPaneState();
      newPanes.push(pane);
      // Register each pane immediately so the pty-output listener can find it
      // when the shell's startup banner arrives — otherwise early panes' first
      // output is dropped while the rest of the grid is still spawning.
      setPanes(prev => [...prev, pane]);
    }
    const tabId = `tab-${nextTabId++}`;
    const tab: TabState = {
      id: tabId,
      name: `${label} ${tabs().length + 1}`,
      paneIds: newPanes.map((p) => p.id),
    };
    batch(() => {
      setTabs(prev => [...prev, tab]);
      setActiveTabId(tabId);
      setTabLayouts(prev => ({ ...prev, [tabId]: preset }));
    });
  }

  const addFourCornerLayout = () => addGridTab(4, "grid", "Grid");
  const addSixPaneGrid     = () => addGridTab(6, "grid-3x2", "3×2");
  const addEightPaneGrid   = () => addGridTab(8, "grid-4x2", "4×2");

  async function closeActivePane() {
    const tabId = activeTabId();
    if (!tabId) return;
    const tab = tabs().find(t => t.id === tabId);
    if (!tab || tab.paneIds.length === 0) return;

    const lastPaneId = tab.paneIds[tab.paneIds.length - 1];
    const pane = panes().find(p => p.id === lastPaneId);
    if (pane) {
      await disposePaneResources(pane, { paneEls, closedStableIds });
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
        disposePaneResources(pane, { paneEls, closedStableIds });
      }
    }
    setPanes(prev => prev.filter(p => !tab.paneIds.includes(p.id)));
    setTabs(prev => prev.filter(t => t.id !== tabId));
    const remaining = tabs().filter(t => t.id !== tabId);
    if (remaining.length > 0) {
      setActiveTabId(remaining[remaining.length - 1].id);
    } else {
      // Never sit on a tabless window — open a fresh shell-picker tab.
      openEmptyTab();
    }
  }

  const mountedPanes = new Set<string>();
  // pane backendId → DOM element. Used by the Tauri file-drop hit-test to
  // figure out which pane the user dropped a file on.
  const paneEls = new Map<string, HTMLDivElement>();

  function mountTerminal(el: HTMLDivElement, pane: PaneState) {
    paneEls.set(pane.backendId, el);
    if (mountedPanes.has(pane.id)) {
      // Already mounted — just refit in case container changed
      pane.fitAddon.fit();
      return;
    }

    pane.terminal.open(el);
    pane.fitAddon.fit();

    // Text drag-drop: drop selected text from another app (or the same
    // window) onto the pane to paste it. Files are intercepted by Tauri
    // and routed via the window-level onDragDropEvent listener — see
    // onMount below.
    el.addEventListener("dragover", (e) => {
      // Only handle text drags; let Tauri's file-drop event take files.
      // `types` contains "Files" for OS file drags; we ignore those here.
      if (e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    });
    el.addEventListener("drop", (e) => {
      if (e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      const text =
        e.dataTransfer?.getData("text/plain") ??
        e.dataTransfer?.getData("text") ??
        "";
      if (!text) return;
      ipc.writePane(pane.backendId, text);
    });
    mountedPanes.add(pane.id);
    
    // Defer WebGL addon loading until browser is idle (non-blocking)
    const loadWebGL = () => {
      loadTerminalModules().then(({ WebglAddon }) => {
        try {
          pane.terminal.loadAddon(new WebglAddon());
        } catch {
          // WebGL not available, fallback to canvas
        }
      });
    };
    
    // Use requestIdleCallback if available, otherwise setTimeout fallback
    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadWebGL);
    } else {
      setTimeout(loadWebGL, 100);
    }
    
    // Measure cell dimensions from the first terminal — used to spawn
    // subsequent panes at the correct size. xterm only exposes these
    // metrics via an internal _core API; fall back to estimates if not available.
    if (!cellDimensions()) {
      try {
        const core = (pane.terminal as any)._core;
        if (core?.viewport?._renderer?.dimensions) {
          const dims = core.viewport._renderer.dimensions;
          const measured = { width: dims.actualCellWidth, height: dims.actualCellHeight };
          setCellDimensions(measured);
          // Cache for future launches
          saveCellDimensions(measured);
        }
      } catch {}
    }

    // Refit on container resize
    const observer = new ResizeObserver(() => {
      pane.fitAddon.fit();
    });
    observer.observe(el);
    // Store observer on pane so disposePaneResources can disconnect it later
    pane.resizeObserver = observer;
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

  // Keep session-manager pane count in sync
  createEffect(() => {
    updateLocalSession({ paneCount: getActivePanes().length });
  });

  // Persist workspace whenever its shape changes (debounced inside saveWorkspace)
  createEffect(() => {
    // Track every dependency BEFORE the gate so subsequent changes still
    // trigger this effect once persistence is enabled.
    const ts = tabs();
    const ps = panes();
    const layouts = tabLayouts();
    const offsets = edgeOffsets();
    const active = activeTabId();
    if (!hydrated()) return;
    // If we're on the welcome screen (no tabs yet), do NOT save — that would
    // wipe the existing saved workspace before the user has a chance to
    // click "Restore last session". Only save when real content exists.
    if (ts.length === 0) return;
    // Translate edge offsets from runtime pane.id keys → stableId keys.
    const offsetsByStable: Record<string, EdgeOffsets> = {};
    for (const [runtimeId, eo] of Object.entries(offsets)) {
      const pane = ps.find((p) => p.id === runtimeId);
      if (!pane) continue;
      // Skip zero-overrides to keep storage clean.
      if (eo.left === 0 && eo.top === 0 && eo.right === 0 && eo.bottom === 0) continue;
      offsetsByStable[pane.stableId] = eo;
    }
    const runtimeWs: Workspace = {
      tabs: ts.map((t) => ({
        id: t.id,
        name: t.name,
        paneStableIds: t.paneIds
          .map((pid) => ps.find((p) => p.id === pid)?.stableId)
          .filter((x): x is string => !!x),
        layoutPreset: layouts[t.id] ?? "auto",
      })),
      activeTabId: active,
      panes: Object.fromEntries(
        ps.map((p) => [p.stableId, { stableId: p.stableId, shellType: p.shellType }]),
      ),
      edgeOffsets: offsetsByStable,
      defaultLayoutPreset: "auto",
    };
    // Reconcile against the launch baseline so a failed/partial restore can
    // never delete tabs or panes — only an explicit close (tombstone) can.
    const ws = reconcileWorkspace({
      runtime: runtimeWs,
      baseline: restoreBaseline,
      tombstones: closedStableIds,
    });
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
              description={`Click to switch to this tab. Contains ${tab.paneIds.length} pane(s). Drag to reorder.`}
              badge={false}
            >
              <div
                class={`tab ${tab.id === activeTabId() ? "active" : ""} ${draggedTabId() === tab.id ? "dragging" : ""} ${dragOverTabId() === tab.id ? "drag-over" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenuPos({ x: e.clientX, y: e.clientY });
                }}
                draggable={true}
                onDragStart={(e) => {
                  setDraggedTabId(tab.id);
                  e.dataTransfer!.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer!.dropEffect = "move";
                  setDragOverTabId(tab.id);
                }}
                onDragLeave={() => {
                  setDragOverTabId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = draggedTabId();
                  const droppedOnId = tab.id;
                  
                  if (draggedId && draggedId !== droppedOnId) {
                    setTabs((prev) => {
                      const draggedIdx = prev.findIndex(t => t.id === draggedId);
                      const droppedIdx = prev.findIndex(t => t.id === droppedOnId);
                      if (draggedIdx === -1 || droppedIdx === -1) return prev;
                      
                      const newTabs = [...prev];
                      const [draggedTab] = newTabs.splice(draggedIdx, 1);
                      newTabs.splice(droppedIdx, 0, draggedTab);
                      return newTabs;
                    });
                  }
                  
                  setDraggedTabId(null);
                  setDragOverTabId(null);
                }}
                onDragEnd={() => {
                  setDraggedTabId(null);
                  setDragOverTabId(null);
                }}
              >
                {(() => {
                  // Get icon from first pane's metadata
                  const firstPaneId = tab.paneIds[0];
                  const pane = panes().find(p => p.id === firstPaneId);
                  const meta = pane ? paneMetaMap()[pane.backendId] : undefined;
                  const icon = getTabIcon(meta?.cwd, meta?.shell ?? pane?.shellType);
                  return <span class="tab-icon">{icon}</span>;
                })()}
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
                title="Open a new tab and pick a shell to launch (Ctrl+T)"
                onClick={() => { openEmptyTab(); setShowAddMenu(false); }}
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
                title="New tab with 4 panes in a 2×2 grid"
                onClick={() => { addFourCornerLayout(); setShowAddMenu(false); }}
              >
                <span class="add-icon">▦</span> 4-Pane Grid (2×2)
              </button>
              <button
                class="add-menu-item"
                title="New tab with 6 panes in a 3×2 grid"
                onClick={() => { addSixPaneGrid(); setShowAddMenu(false); }}
              >
                <span class="add-icon">⊞</span> 6-Pane Grid (3×2)
              </button>
              <button
                class="add-menu-item"
                title="New tab with 8 panes in a 4×2 grid"
                onClick={() => { addEightPaneGrid(); setShowAddMenu(false); }}
              >
                <span class="add-icon">⊟</span> 8-Pane Grid (4×2)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tab right-click menu: set the global default shell for new tabs/panes */}
      <Show when={tabMenuPos()}>
        {(pos) => (
          <>
            <div
              style={{ position: "fixed", inset: "0", "z-index": 999 }}
              onClick={() => setTabMenuPos(null)}
              onContextMenu={(e) => { e.preventDefault(); setTabMenuPos(null); }}
            />
            <div
              class="add-menu"
              style={{ position: "fixed", left: `${pos().x}px`, top: `${pos().y}px`, "z-index": 1000 }}
            >
              <button
                class="add-menu-item"
                title="New tabs and panes launch the system default shell"
                onClick={() => { setDefaultShell(null); setTabMenuPos(null); }}
              >
                <span class="add-icon">{defaultShell() === null ? "✓" : ""}</span> Default shell: System default
              </button>
              <For each={shells()}>
                {(s) => (
                  <button
                    class="add-menu-item"
                    title={`New tabs and panes launch ${s.path}`}
                    onClick={() => { setDefaultShell(s.path); setTabMenuPos(null); }}
                  >
                    <span class="add-icon">{defaultShell() === s.path ? "✓" : ""}</span> Default shell: {s.name}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>

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
        <Show when={activeTabIsEmpty()}>
          <div class="welcome">
            <div class="welcome-card">
              <div class="welcome-logo">▦</div>
              <div class="welcome-title">TermGrid</div>
              <div class="welcome-sub">Pick a shell to start this tab.</div>

              <div class="welcome-shells">
                <Show
                  when={shells().length > 0 || defaultShellInfo()}
                  fallback={
                    <button class="welcome-shell-btn default" onClick={() => launchShellInActiveTab()}>
                      <span class="ws-default-tag">DEFAULT</span>
                      <span class="ws-name">Default shell</span>
                      <span class="ws-kind">Opens your system shell</span>
                    </button>
                  }
                >
                  {(() => {
                    const dflt = defaultShellInfo();
                    const list = shells();
                    const mru = mruShellPath();
                    const isDefault = (s: ipc.ShellInfo) =>
                      !!dflt && (s.path === dflt.path || s.name === dflt.name);
                    const isMru = (s: ipc.ShellInfo) => !!mru && s.path === mru;
                    
                    // Sort: MRU first, then default, then rest
                    const sorted = [...list].sort((a, b) => {
                      if (isMru(a) && !isMru(b)) return -1;
                      if (!isMru(a) && isMru(b)) return 1;
                      return Number(isDefault(b)) - Number(isDefault(a));
                    });
                    if (sorted.length === 0 && dflt) sorted.push(dflt);
                    
                    return (
                      <For each={sorted}>
                        {(s, idx) => {
                          const isMacBash = s.path === "/bin/bash" && /Mac/i.test(navigator.userAgent);
                          const isMruShell = isMru(s);
                          return (
                            <button
                              ref={(el) => {
                                // Auto-focus based on keyboard selection or MRU
                                if (idx() === welcomeShellIndex()) {
                                  setTimeout(() => el.focus(), 100);
                                }
                              }}
                              class={`welcome-shell-btn ${isDefault(s) && !isMruShell ? "default" : ""} ${isMruShell ? "mru" : ""} ${isMacBash ? "warn" : ""} ${idx() === welcomeShellIndex() ? "kb-focused" : ""} ${defaultShell() === s.path ? "user-default" : ""}`}
                              onClick={() => launchShellInActiveTab(s.path)}
                              onMouseEnter={() => {
                                prefetchTerminalModules();
                                setWelcomeShellIndex(idx());
                              }}
                              title={isMacBash
                                ? "macOS ships an old bash 3.2 that prints a deprecation warning on launch — pick zsh instead."
                                : s.path}
                            >
                              <Show when={isMruShell}>
                                <span class="ws-mru-tag">LAST USED</span>
                              </Show>
                              <Show when={isDefault(s) && !isMruShell}>
                                <span class="ws-default-tag">SYSTEM</span>
                              </Show>
                              <Show when={isMacBash}>
                                <span class="ws-warn-tag">OLD</span>
                              </Show>
                              <span
                                class={`ws-default-star ${defaultShell() === s.path ? "active" : ""}`}
                                role="button"
                                tabindex={-1}
                                title={defaultShell() === s.path
                                  ? "This is your default shell — click to clear"
                                  : "Set as default shell for new tabs/panes"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDefaultShell(defaultShell() === s.path ? null : s.path);
                                }}
                              >
                                {defaultShell() === s.path ? "★" : "☆"}
                              </span>
                              <span class="ws-name">{s.name}</span>
                              <span class="ws-kind">{s.path}</span>
                            </button>
                          );
                        }}
                      </For>
                    );
                  })()}
                </Show>
              </div>

              <div class="welcome-tips">
                <kbd>Ctrl+T</kbd> new tab · <kbd>Ctrl+N</kbd> split · <kbd>Ctrl+R</kbd> history
              </div>
            </div>
          </div>
        </Show>
        <Index each={tabs()}>
          {(tab) => {
            const isActive = () => tab().id === activeTabId();
            const tabPanes = () => getPanesForTab(tab().id);
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
        </Index>
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
        <span>default shell: {(() => {
          const d = defaultShell();
          if (!d) return "system";
          return shells().find((s) => s.path === d)?.name ?? d;
        })()}</span>
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

      {/* Command Palette */}
      <Show when={showCommandPalette()}>
        <CommandPalette
          commands={paletteCommands()}
          onClose={() => setShowCommandPalette(false)}
        />
      </Show>

      {/* Adoption Picker */}
      <Show when={showAdoptionPicker()}>
        <AdoptionPicker
          onClose={() => {
            setShowAdoptionPicker(false);
            setAdoptionParentFilter(null);
          }}
          initialParentFilter={adoptionParentFilter()}
          onPick={(s, mode, strategy, snap, options) =>
            adoptSession(s, mode, strategy, snap, options)
          }
        />
      </Show>

      {/* Global Search */}
      <Show when={showGlobalSearch()}>
        <GlobalSearch
          panes={panes()}
          onClose={() => setShowGlobalSearch(false)}
          onSelectResult={(paneId, lineNumber) => {
            // Focus the pane
            const pane = panes().find(p => p.id === paneId);
            if (!pane) return;
            
            // Switch to the tab containing this pane
            const tab = tabs().find(t => t.paneIds.includes(paneId));
            if (tab) setActiveTabId(tab.id);
            
            // Set focus
            setFocusedPaneId(paneId);
            
            // Scroll to the line (best effort)
            try {
              pane.terminal.scrollToLine(lineNumber);
            } catch {}
          }}
        />
      </Show>

      {/* Session Templates */}
      <Show when={showTemplateManager()}>
        <TemplateManager
          onClose={() => setShowTemplateManager(false)}
          onLoadTemplate={loadTemplateLayout}
          onSaveTemplate={saveSessionAsTemplate}
          currentSession={{
            tabCount: tabs().length,
            paneCount: panes().length,
          }}
        />
      </Show>

      {/* Theme Picker */}
      <Show when={showThemePicker()}>
        <div
          class="theme-picker-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowThemePicker(false);
          }}
        >
          <div class="theme-picker">
            <div class="tp-header">
              <h2>Choose Theme</h2>
              <button class="tp-close" onClick={() => setShowThemePicker(false)}>✕</button>
            </div>
            <div class="tp-themes">
              <For each={themes.BUILT_IN_THEMES}>
                {(theme) => (
                  <button
                    class={`tp-theme ${currentTheme().id === theme.id ? "selected" : ""}`}
                    onClick={async () => {
                      setCurrentTheme(theme);
                      await themes.setSelectedTheme(theme.id);
                      
                      // Update all existing terminals
                      for (const pane of panes()) {
                        pane.terminal.options.theme = {
                          background: theme.background,
                          foreground: theme.foreground,
                          cursor: theme.cursor,
                          cursorAccent: theme.cursorAccent,
                          selectionBackground: theme.selectionBackground,
                          black: theme.black,
                          red: theme.red,
                          green: theme.green,
                          yellow: theme.yellow,
                          blue: theme.blue,
                          magenta: theme.magenta,
                          cyan: theme.cyan,
                          white: theme.white,
                          brightBlack: theme.brightBlack,
                          brightRed: theme.brightRed,
                          brightGreen: theme.brightGreen,
                          brightYellow: theme.brightYellow,
                          brightBlue: theme.brightBlue,
                          brightMagenta: theme.brightMagenta,
                          brightCyan: theme.brightCyan,
                          brightWhite: theme.brightWhite,
                        };
                      }
                      
                      setShowThemePicker(false);
                    }}
                    style={{
                      "background": theme.background,
                      "border-color": currentTheme().id === theme.id ? theme.blue : theme.black,
                    }}
                  >
                    <div class="tp-theme-name" style={{ "color": theme.foreground }}>
                      {theme.name}
                    </div>
                    <div class="tp-theme-preview">
                      <span style={{ "color": theme.red }}>█</span>
                      <span style={{ "color": theme.green }}>█</span>
                      <span style={{ "color": theme.yellow }}>█</span>
                      <span style={{ "color": theme.blue }}>█</span>
                      <span style={{ "color": theme.magenta }}>█</span>
                      <span style={{ "color": theme.cyan }}>█</span>
                    </div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default App;
