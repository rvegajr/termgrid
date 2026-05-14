import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  clearSnapshotCache,
  clipboardCapture,
  describeSshTarget,
  diffStaleRows,
  formatAge,
  isLikelySystemShell,
  listAdoptableSessions,
  rememberSnapshot,
  renderSshReconnect,
  snapshotSessionCached,
  type AdoptableSession,
  type AdoptionMode,
  type AdoptionStrategy,
  type SessionSnapshot,
} from "../services/adoption";

/**
 * AdoptionPicker v3 — the full-featured cut.
 *
 * v2 was a split-pane list + preview. v3 layers in:
 *  - **Auto-refresh** every 3 s while open, with a stale-row fade-out
 *    so the user sees liveness without manual rescans.
 *  - **Multi-select**: ⌘-click (or `Space`) toggles a row's selection;
 *    Enter spawns one tab per selected row. Falls back to single-row
 *    behavior when nothing is selected.
 *  - **History injection toggle** — opt-in checkbox that, when enabled,
 *    seeds the adopted pane's PTY with the adopted shell's last few
 *    commands so the user's local Ctrl-R recall lights up immediately.
 *  - **Frontmost-app pre-filter** — opening the picker via the
 *    "Adopt frontmost terminal" palette command pins the parent column
 *    to a specific host.
 *  - **Snapshot caching** — hovering a row prefetches its snapshot
 *    once; re-hovering uses the cache.
 *
 * Keyboard:
 *  - `↑/↓`        — move highlight
 *  - `Space`      — toggle selection of the highlighted row
 *  - `Enter`      — adopt selected rows (or highlighted row if none
 *                    selected) using current `mode`
 *  - `Alt+Enter`  — override mode to `active-pane`
 *  - `Shift+Enter`— override mode to `split`
 *  - `⌘R`         — manual rescan
 *  - `Esc`        — close
 */
interface Props {
  onClose: () => void;
  /**
   * Optional pre-filter applied on mount: only rows whose `parent`
   * matches (case-insensitive substring) appear initially. Cleared on
   * the first keystroke so the user isn't trapped by the filter.
   */
  initialParentFilter?: string | null;
  /**
   * Called once per row the user picks. The caller is responsible for
   * spawning panes — the picker only orchestrates intent.
   */
  onPick: (
    session: AdoptableSession,
    mode: AdoptionMode,
    strategy: AdoptionStrategy,
    snapshot: SessionSnapshot | null,
    options: AdoptionOptions,
  ) => void;
}

/** **v3** options the picker carries alongside each pick. */
export interface AdoptionOptions {
  /** When `true`, the adopting pane should pre-populate its Ctrl-R store. */
  injectHistory: boolean;
  /** When `true`, forward allow-listed env vars over ssh via `SendEnv`. */
  forwardEnvOverSsh: boolean;
}

const POLL_MS = 3000;

export function AdoptionPicker(props: Props) {
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  const [mode, setMode] = createSignal<AdoptionMode>("new-tab");
  const [excludeSystem, setExcludeSystem] = createSignal(true);
  const [parentFilter, setParentFilter] = createSignal<string | null>(
    props.initialParentFilter ?? null,
  );
  const [selectedKeys, setSelectedKeys] = createSignal<Set<string>>(new Set());
  const [injectHistory, setInjectHistory] = createSignal(false);
  const [forwardEnv, setForwardEnv] = createSignal(true);
  // PIDs that vanished between polls — animated out before removal.
  const [stalePids, setStalePids] = createSignal<Set<number>>(new Set());
  // v4: opt-in clipboard capture output, surfaced under the preview pane
  // when the user hits the "Try clipboard capture" button.
  const [clipText, setClipText] = createSignal<string | null>(null);
  const [clipReason, setClipReason] = createSignal<string | null>(null);
  const [clipBusy, setClipBusy] = createSignal(false);

  // Underlying signal so we can drive `createResource` deterministically
  // from setInterval + manual rescans.
  const [pollTick, setPollTick] = createSignal(0);

  const [sessions, { refetch }] = createResource<AdoptableSession[], number>(
    pollTick,
    async (_, info) => {
      try {
        const next = await listAdoptableSessions();
        const prev = info.value ?? [];
        const stale = diffStaleRows(prev, next);
        if (stale.length > 0) {
          // Hold stale rows visible briefly so the user perceives the
          // transition rather than a sudden pop.
          setStalePids(new Set<number>(stale));
          setTimeout(() => setStalePids(new Set<number>()), 800);
        }
        return next;
      } catch (err) {
        console.error("listAdoptableSessions failed:", err);
        return info.value ?? [];
      }
    },
  );

  let inputRef: HTMLInputElement | undefined;

  /** Stable key for a row (PID can be reused after death). */
  const rowKey = (s: AdoptableSession) => `${s.pid}:${s.started_at}`;

  const filtered = createMemo<AdoptableSession[]>(() => {
    const all = sessions() ?? [];
    const q = query().trim().toLowerCase();
    const pf = parentFilter()?.toLowerCase() ?? null;
    return all.filter((s) => {
      if (excludeSystem() && isLikelySystemShell(s)) return false;
      if (pf && !(s.parent ?? "").toLowerCase().includes(pf)) return false;
      if (!q) return true;
      const hay = [
        s.shell,
        s.cwd ?? "",
        s.tty ?? "",
        s.parent ?? "",
        s.last_command ?? "",
        String(s.pid),
        s.via_ssh ? "ssh" : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  });

  // Reset highlight when the visible row set changes.
  createEffect(on(filtered, () => setHighlight(0)));

  // Auto-refresh while picker is open. Disposed on unmount.
  const pollHandle = setInterval(() => setPollTick((n) => n + 1), POLL_MS);
  onCleanup(() => clearInterval(pollHandle));

  // Lazy snapshot for the highlighted row — feeds the preview pane and
  // primes the cache for the actual adopt call.
  const highlightedPid = createMemo<number | null>(() => {
    const rows = filtered();
    const i = Math.min(highlight(), rows.length - 1);
    return i >= 0 ? rows[i]?.pid ?? null : null;
  });

  const [preview] = createResource<SessionSnapshot | null, number | null>(
    highlightedPid,
    async (pid) => {
      if (pid == null) return null;
      try {
        const snap = await snapshotSessionCached(pid);
        return snap;
      } catch (err) {
        console.warn("snapshotSession failed for", pid, err);
        return null;
      }
    },
  );

  // When the preview lands, write back into the cache (already happens
  // via snapshotSessionCached, but doing it explicitly here too is a
  // belt-and-suspenders for parents that pre-fetched without caching).
  createEffect(() => {
    const snap = preview();
    if (snap) rememberSnapshot(snap.pid, snap);
  });

  const toggleSelect = (s: AdoptableSession) => {
    const k = rowKey(s);
    const cur = new Set(selectedKeys());
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
    setSelectedKeys(cur);
  };

  const isSelected = (s: AdoptableSession) => selectedKeys().has(rowKey(s));

  const submit = (
    e: KeyboardEvent | MouseEvent,
    overrideMode?: AdoptionMode,
    overrideStrategy?: AdoptionStrategy,
    overrideTargets?: AdoptableSession[],
  ) => {
    const rows = filtered();
    const targets: AdoptableSession[] = [];
    if (overrideTargets && overrideTargets.length > 0) {
      targets.push(...overrideTargets);
    } else {
      const selSet = selectedKeys();
      if (selSet.size > 0) {
        for (const r of rows) if (selSet.has(rowKey(r))) targets.push(r);
      } else {
        const idx = highlight();
        if (idx >= 0 && rows[idx]) targets.push(rows[idx]);
      }
    }
    if (targets.length === 0) return;

    const opts: AdoptionOptions = {
      injectHistory: injectHistory(),
      forwardEnvOverSsh: forwardEnv(),
    };

    // Compute effective mode: keyboard modifiers from the originating
    // event take precedence over the toolbar selection.
    const effectiveMode: AdoptionMode = overrideMode
      ? overrideMode
      : e instanceof KeyboardEvent && e.altKey
        ? "active-pane"
        : e instanceof KeyboardEvent && e.shiftKey
          ? "split"
          : mode();

    props.onClose();
    for (const t of targets) {
      const cur = preview();
      const snap = cur && cur.pid === t.pid ? cur : null;
      props.onPick(
        t,
        effectiveMode,
        overrideStrategy ?? "local-cwd",
        snap,
        opts,
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(filtered().length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === " " || e.code === "Space") {
      // Don't grab Space when the user is typing — only when the input
      // is empty (treat Space as "toggle selection of highlighted").
      if (query().length === 0) {
        e.preventDefault();
        const row = filtered()[highlight()];
        if (row) toggleSelect(row);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submit(e);
      return;
    }
    if ((e.key === "r" || e.key === "R") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      clearSnapshotCache();
      refetch();
    }
  };

  onMount(() => {
    inputRef?.focus();
  });

  const onWindowFocus = () => refetch();
  window.addEventListener("focus", onWindowFocus);
  onCleanup(() => window.removeEventListener("focus", onWindowFocus));

  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1) + "\u2026" : s;

  const cmdKey = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl";

  return (
    <div
      class="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="command-palette adoption-picker adoption-picker-v3">
        <input
          ref={inputRef}
          type="text"
          class="cp-input"
          placeholder={
            parentFilter()
              ? `Adopt session from ${parentFilter()}\u2026`
              : "Adopt session \u2014 filter by shell, cwd, pid, tty\u2026"
          }
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            // First keystroke clears the parent pre-filter — the user
            // is choosing their own scope now.
            if (parentFilter()) setParentFilter(null);
          }}
          onKeyDown={onKeyDown}
        />

        <div class="adoption-toolbar">
          <div class="adoption-toolbar-group">
            <span class="adoption-toolbar-label">Open in:</span>
            <For each={["new-tab", "active-pane", "split"] as AdoptionMode[]}>
              {(m) => (
                <button
                  type="button"
                  class={`adoption-mode-btn ${mode() === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                  title={
                    m === "new-tab"
                      ? "Open in a brand-new tab (default)"
                      : m === "active-pane"
                        ? "Retrofit the currently focused pane (Alt+Enter)"
                        : "Split the active tab (Shift+Enter)"
                  }
                >
                  {m === "new-tab"
                    ? "New tab"
                    : m === "active-pane"
                      ? "Active pane"
                      : "Split"}
                </button>
              )}
            </For>
          </div>
          <div class="adoption-toolbar-group">
            <label class="adoption-toolbar-check" title="Hide processes that look like daemon shells (no tty, root cwd)">
              <input
                type="checkbox"
                checked={excludeSystem()}
                onChange={(e) => setExcludeSystem(e.currentTarget.checked)}
              />
              <span>Hide system</span>
            </label>
            <label class="adoption-toolbar-check" title="Pre-populate the new pane's Ctrl-R recall with adopted shell's recent commands">
              <input
                type="checkbox"
                checked={injectHistory()}
                onChange={(e) => setInjectHistory(e.currentTarget.checked)}
              />
              <span>Inject history</span>
            </label>
            <label class="adoption-toolbar-check" title="When reconnecting via SSH, forward toolchain env vars to the remote with -o SendEnv=...">
              <input
                type="checkbox"
                checked={forwardEnv()}
                onChange={(e) => setForwardEnv(e.currentTarget.checked)}
              />
              <span>Forward env</span>
            </label>
            <button
              type="button"
              class="adoption-refresh"
              onClick={() => {
                clearSnapshotCache();
                refetch();
              }}
              title={`Rescan processes (${cmdKey}+R)`}
            >
              <Show when={sessions.loading} fallback={<>\u21bb Rescan</>}>
                Scanning\u2026
              </Show>
            </button>
          </div>
        </div>

        <Show when={selectedKeys().size > 0}>
          <div class="adoption-selectbar">
            <span>{selectedKeys().size} selected</span>
            <button
              type="button"
              class="adoption-link"
              onClick={() => setSelectedKeys(new Set())}
            >
              clear
            </button>
            <button
              type="button"
              class="adoption-mode-btn active"
              onClick={(e) => submit(e)}
            >
              Adopt {selectedKeys().size}
            </button>
          </div>
        </Show>

        {/* v4: bulk-adopt strip. Visible whenever the filter resolves
            to a recognizable host (Terminal.app, Cursor, etc.) AND the
            user hasn't yet selected anything. Caps at 8 to avoid
            accidentally spawning a swarm of tabs. */}
        <Show
          when={
            selectedKeys().size === 0 &&
            filtered().length > 1 &&
            filtered().length <= 32
          }
        >
          <div class="adoption-bulkbar">
            <span class="adoption-bulkbar-hint">
              {parentFilter()
                ? `${filtered().length} shells under ${parentFilter()}`
                : `${filtered().length} shells shown`}
            </span>
            <button
              type="button"
              class="adoption-link"
              onClick={(e) => {
                const cap = Math.min(filtered().length, 8);
                if (
                  cap > 3 &&
                  !window.confirm(
                    `Open ${cap} new TermGrid tabs for the visible shells?`,
                  )
                ) {
                  return;
                }
                submit(e, "new-tab", "local-cwd", filtered().slice(0, cap));
              }}
              title="Open one new tab per visible shell (capped at 8)"
            >
              Adopt all (\u2264{Math.min(filtered().length, 8)})
            </button>
          </div>
        </Show>

        <div class="adoption-body">
          <div class="cp-results adoption-results">
            <Show
              when={!sessions.loading || (sessions() ?? []).length > 0}
              fallback={<div class="cp-empty">Scanning processes\u2026</div>}
            >
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="cp-empty">
                    No adoptable shells
                    <Show when={excludeSystem()}>
                      {" "}
                      <button
                        class="adoption-link"
                        type="button"
                        onClick={() => setExcludeSystem(false)}
                      >
                        Show system shells?
                      </button>
                    </Show>
                    <Show when={parentFilter()}>
                      {" "}
                      <button
                        class="adoption-link"
                        type="button"
                        onClick={() => setParentFilter(null)}
                      >
                        Clear "{parentFilter()}" filter?
                      </button>
                    </Show>
                  </div>
                }
              >
                <For each={filtered()}>
                  {(s, idx) => (
                    <button
                      type="button"
                      class={`cp-item adoption-item ${
                        idx() === highlight() ? "selected" : ""
                      } ${isSelected(s) ? "multipicked" : ""} ${
                        stalePids().has(s.pid) ? "stale" : ""
                      }`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) {
                          e.preventDefault();
                          toggleSelect(s);
                        } else {
                          setHighlight(idx());
                          submit(e);
                        }
                      }}
                      onMouseEnter={() => setHighlight(idx())}
                    >
                      <div class="cp-item-name">
                        <Show when={isSelected(s)}>
                          <span class="adopt-multi-mark">\u2713</span>
                        </Show>
                        <span class="adopt-shell">
                          {s.via_ssh ? "ssh \u2192 " : ""}
                          {s.shell}
                        </span>
                        <span class="adopt-pid">pid {s.pid}</span>
                        <span class="adopt-age">
                          {formatAge(s.started_at)}
                        </span>
                      </div>
                      <div class="cp-item-desc adopt-desc">
                        <Show when={s.cwd}>
                          <span class="adopt-cwd" title={s.cwd ?? ""}>
                            {truncate(s.cwd ?? "", 60)}
                          </span>
                        </Show>
                        <Show when={s.parent}>
                          <span class="adopt-parent">via {s.parent}</span>
                        </Show>
                        <Show when={s.tty}>
                          <span class="adopt-tty">{s.tty}</span>
                        </Show>
                        <Show when={s.last_command}>
                          <span class="adopt-last" title={s.last_command ?? ""}>
                            $ {truncate(s.last_command ?? "", 50)}
                          </span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>

          <div class="adoption-preview">
            <Show
              when={preview()}
              fallback={
                <Show
                  when={preview.loading}
                  fallback={
                    <div class="adoption-preview-empty">
                      Highlight a row to preview its context
                    </div>
                  }
                >
                  <div class="adoption-preview-empty">Loading preview\u2026</div>
                </Show>
              }
            >
              {(snap) => (
                <div class="adoption-preview-body">
                  <Show when={snap().ssh_target}>
                    <div class="adoption-preview-row adoption-ssh-row">
                      <div class="adoption-preview-label">SSH session</div>
                      <div class="adoption-ssh-desc">
                        <span class="adopt-ssh-dest">
                          {describeSshTarget(snap().ssh_target)}
                        </span>
                        <button
                          type="button"
                          class="adoption-ssh-reconnect"
                          onClick={(e) => submit(e, undefined, "ssh-reconnect")}
                          title={`Run: ${renderSshReconnect(
                            snap().ssh_target!,
                            forwardEnv()
                              ? snap().env_vars.map((v) => v.name)
                              : [],
                          )}`}
                        >
                          Reconnect via ssh
                        </button>
                      </div>
                    </div>
                  </Show>

                  <Show when={snap().env_vars.length > 0}>
                    <div class="adoption-preview-row">
                      <div class="adoption-preview-label">
                        Toolchain env ({snap().env_vars.length})
                      </div>
                      <div class="adoption-env-list">
                        <For each={snap().env_vars}>
                          {(ev) => (
                            <div class="adoption-env-item">
                              <span class="adoption-env-name">{ev.name}</span>
                              <span class="adoption-env-value">
                                {truncate(ev.value, 80)}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={snap().recent_history.length > 0 && injectHistory()}>
                    <div class="adoption-preview-row">
                      <div class="adoption-preview-label">
                        Recent history (will be seeded)
                      </div>
                      <div class="adoption-env-list">
                        <For each={snap().recent_history.slice(-6)}>
                          {(cmd) => (
                            <div class="adoption-env-item">
                              <span class="adoption-env-value">
                                $ {truncate(cmd, 100)}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={snap().buffer_preview}>
                    <div class="adoption-preview-row">
                      <div class="adoption-preview-label">Visible buffer</div>
                      <pre class="adoption-buffer">
                        {snap().buffer_preview}
                      </pre>
                    </div>
                  </Show>

                  {/* v4: opt-in clipboard scrape for hosts we can't
                      introspect. Hidden until the user explicitly asks. */}
                  <Show when={!snap().buffer_preview}>
                    <div class="adoption-preview-row">
                      <div class="adoption-preview-label">Buffer capture</div>
                      <Show when={clipText()} fallback={
                        <div class="adoption-clip-empty">
                          <Show when={clipReason()}>
                            <span class="adoption-clip-reason">{clipReason()}</span>
                          </Show>
                          <button
                            type="button"
                            class="adoption-link"
                            disabled={clipBusy()}
                            onClick={async () => {
                              setClipBusy(true);
                              try {
                                const out = await clipboardCapture();
                                setClipText(out.text ?? null);
                                setClipReason(out.reason ?? null);
                              } finally {
                                setClipBusy(false);
                              }
                            }}
                            title="Linux/X11 only. Steals focus briefly to send Ctrl+Shift+A then Ctrl+Shift+C, then restores your clipboard."
                          >
                            {clipBusy()
                              ? "Capturing\u2026"
                              : "Try clipboard capture"}
                          </button>
                        </div>
                      }>
                        <pre class="adoption-buffer">{clipText()}</pre>
                      </Show>
                    </div>
                  </Show>

                  <Show
                    when={
                      !snap().ssh_target &&
                      snap().env_vars.length === 0 &&
                      !snap().buffer_preview &&
                      !clipText()
                    }
                  >
                    <div class="adoption-preview-empty">
                      No extra context captured
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </div>

        <div class="adoption-footer">
          <span>
            <kbd>\u2191\u2193</kbd> navigate
          </span>
          <span>
            <kbd>Space</kbd> select multiple
          </span>
          <span>
            <kbd>Enter</kbd>{" "}
            {selectedKeys().size > 0
              ? `adopt ${selectedKeys().size}`
              : mode() === "new-tab"
                ? "open in new tab"
                : mode() === "active-pane"
                  ? "open in active pane"
                  : "split active tab"}
          </span>
          <span>
            <kbd>Alt+Enter</kbd> active pane
          </span>
          <span>
            <kbd>Shift+Enter</kbd> split
          </span>
          <span>
            <kbd>{cmdKey}+R</kbd> rescan
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
