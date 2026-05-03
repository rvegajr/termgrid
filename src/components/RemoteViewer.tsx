import { For, createEffect, createMemo, onCleanup } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onRemoteOutput, panesFor, b64ToBytes, remotePanes } from "../services/relay";
import {
  calculateLayoutPreset,
  type LayoutPreset,
} from "../services/layout-engine";

interface Props {
  peerId: string;
  layout: LayoutPreset;
}

interface Mirror {
  paneId: string;
  terminal: Terminal;
  fit: FitAddon;
}

export function RemoteViewer(props: Props) {
  const mirrors = new Map<string, Mirror>();

  // Reactively read this peer's pane list. `remotePanes()` is keyed by peerId.
  const list = createMemo(() => {
    void remotePanes();
    return panesFor(props.peerId);
  });
  const layouts = createMemo(() =>
    calculateLayoutPreset(props.layout, list().length),
  );

  function ensureMirror(paneId: string): Mirror {
    let m = mirrors.get(paneId);
    if (m) return m;
    const terminal = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 14,
      scrollback: 100_000,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
      theme: {
        background: "#181825",
        foreground: "#cdd6f4",
        cursor: "#585b70",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    m = { paneId, terminal, fit };
    mirrors.set(paneId, m);
    return m;
  }

  const off = onRemoteOutput((from: string, paneId: string, b64: string) => {
    if (from !== props.peerId) return;
    const m = mirrors.get(paneId);
    if (!m) return;
    m.terminal.write(b64ToBytes(b64));
  });

  // Drop terminals for panes the host no longer has.
  createEffect(() => {
    const present = new Set(list().map((p: any) => p.paneId));
    for (const id of Array.from(mirrors.keys())) {
      if (!present.has(id)) {
        const m = mirrors.get(id)!;
        m.terminal.dispose();
        mirrors.delete(id);
      }
    }
  });

  onCleanup(() => {
    off();
    for (const m of mirrors.values()) m.terminal.dispose();
    mirrors.clear();
  });

  return (
    <div class="remote-viewer">
      <For each={list()} fallback={
        <div class="remote-empty">
          Waiting for pane list from {props.peerId}…
        </div>
      }>
        {(p: any, idx) => {
          const lyt = () => layouts()[idx()] ?? { x: 0, y: 0, width: 100, height: 100 };
          const m = ensureMirror(p.paneId);
          return (
            <div
              class="remote-pane"
              style={{
                position: "absolute",
                left: `${lyt().x}%`,
                top: `${lyt().y}%`,
                width: `${lyt().width}%`,
                height: `${lyt().height}%`,
              }}
              ref={(el) => {
                requestAnimationFrame(() => {
                  if (!el.querySelector(".xterm")) {
                    m.terminal.open(el);
                    m.fit.fit();
                  }
                });
              }}
            >
              {p.label && <div class="remote-pane-label">{p.label}</div>}
            </div>
          );
        }}
      </For>
    </div>
  );
}
