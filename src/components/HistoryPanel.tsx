import { createSignal, For, Show, onMount, createEffect } from "solid-js";
import * as ipc from "../services/tauri-ipc";
import { localPeerId } from "../services/relay";
import { HelpTip } from "./HelpTip";

interface Props {
  paneId: string | null;
  open: boolean;
  onClose: () => void;
  onPick: (cmd: string) => void;
}

export function HistoryPanel(props: Props) {
  const [scope, setScope] = createSignal<"pane" | "global">("pane");
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createSignal<ipc.HistoryRecord[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;

  async function refresh() {
    if (!props.open) return;
    const sc: ipc.HistoryScope =
      scope() === "pane" && props.paneId
        ? { kind: "pane", pane_id: props.paneId }
        : { kind: "global" };
    try {
      const data = await ipc.historySearch(sc, query(), 200);
      setRows(data);
      setError(null);
    } catch (e: any) {
      setError(String(e));
      setRows([]);
    }
  }

  onMount(() => {
    if (props.open) inputRef?.focus();
  });

  createEffect(() => {
    void scope();
    void query();
    void props.open;
    void props.paneId;
    refresh();
  });

  function fmtTs(ms: number) {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <Show when={props.open}>
      <div class="history-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
        <div class="history-panel">
          <div class="history-header">
            <span class="history-title">Command history</span>
            <span class="history-session">{localPeerId()}</span>
            <div class="history-scope">
              <HelpTip title="This pane" description="Search only commands typed in the currently focused pane." badge={false} placement="bottom">
                <button
                  class={`scope-btn ${scope() === "pane" ? "active" : ""}`}
                  disabled={!props.paneId}
                  onClick={() => setScope("pane")}
                >This pane</button>
              </HelpTip>
              <HelpTip title="Global" description="Search every command across every pane and session you've ever run." badge={false} placement="bottom">
                <button
                  class={`scope-btn ${scope() === "global" ? "active" : ""}`}
                  onClick={() => setScope("global")}
                >Global</button>
              </HelpTip>
            </div>
            <button class="history-close" onClick={props.onClose}>×</button>
          </div>
          <input
            ref={inputRef}
            class="history-input"
            placeholder="Search commands… (FTS — try `git commit`, `cd src`, `npm`)"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") props.onClose();
              if (e.key === "Enter" && rows().length > 0) {
                props.onPick(rows()[0].cmd);
                props.onClose();
              }
            }}
          />
          <Show when={error()}>
            <div class="history-error">{error()}</div>
          </Show>
          <div class="history-list">
            <For each={rows()} fallback={<div class="history-empty">No matches</div>}>
              {(r) => (
                <button
                  class="history-row"
                  onClick={() => { props.onPick(r.cmd); props.onClose(); }}
                  title={`exit ${r.exit_code ?? "?"} • ${r.duration_ms ?? "?"} ms`}
                >
                  <span class="hr-time">{fmtTs(r.started_at)}</span>
                  <Show when={r.cwd}><span class="hr-cwd">{r.cwd}</span></Show>
                  <span class="hr-cmd">{r.cmd}</span>
                  <Show when={typeof r.exit_code === "number" && r.exit_code !== 0}>
                    <span class="hr-exit">{r.exit_code}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
