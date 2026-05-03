import { createSignal, For, Show, onCleanup } from "solid-js";
import { terminalPrefs, updatePrefs, FONT_OPTIONS } from "../services/terminal-prefs";
import { clearWorkspace } from "../services/workspace";
import { purgeAllSnapshots } from "../services/pane-snapshot";

export function SettingsMenu() {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  function onDocClick(e: MouseEvent) {
    if (!rootRef) return;
    if (!rootRef.contains(e.target as Node)) setOpen(false);
  }
  document.addEventListener("mousedown", onDocClick);
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  const SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22];

  return (
    <div class="settings-wrap" ref={rootRef}>
      <button
        class="settings-btn"
        onClick={() => setOpen((p) => !p)}
        title="Terminal settings — font, size, cursor, workspace reset"
      >
        ⚙
      </button>
      <Show when={open()}>
        <div class="settings-menu">
          <div class="settings-row">
            <label class="settings-label">Font</label>
            <select
              class="settings-select"
              value={terminalPrefs().fontFamily}
              onChange={(e) => updatePrefs({ fontFamily: e.currentTarget.value })}
            >
              <For each={FONT_OPTIONS}>
                {(f) => (
                  <option value={f} style={{ "font-family": `'${f}', monospace` }}>{f}</option>
                )}
              </For>
            </select>
          </div>
          <div class="settings-row">
            <label class="settings-label">Size</label>
            <div class="settings-sizes">
              <For each={SIZES}>
                {(s) => (
                  <button
                    class={`size-btn ${terminalPrefs().fontSize === s ? "active" : ""}`}
                    onClick={() => updatePrefs({ fontSize: s })}
                  >{s}</button>
                )}
              </For>
            </div>
          </div>
          <div class="settings-row">
            <label class="settings-label">Cursor</label>
            <label class="settings-toggle">
              <input
                type="checkbox"
                checked={terminalPrefs().cursorBlink}
                onChange={(e) => updatePrefs({ cursorBlink: e.currentTarget.checked })}
              />
              <span>Blink</span>
            </label>
          </div>
          <div class="settings-row">
            <label class="settings-label">Workspace</label>
            <button
              class="settings-danger"
              onClick={async () => {
                if (confirm("Reset workspace? Wipes saved tabs, panes, AND on-disk scrollback files. Returns you to the start screen.")) {
                  clearWorkspace();
                  await purgeAllSnapshots();
                  location.reload();
                }
              }}
            >
              Reset workspace
            </button>
          </div>
          <div class="settings-preview" style={{
            "font-family": `'${terminalPrefs().fontFamily}', monospace`,
            "font-size": `${terminalPrefs().fontSize}px`,
          }}>
            <span class="prev-prompt">~/dev </span>
            <span class="prev-cmd">git status</span>
            <span class="prev-out">aA bB cC 0123 -- &gt;= != == ≈ →</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
