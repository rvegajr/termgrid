import { For, Show } from "solid-js";
import {
  remoteSessions,
  activeSession,
  selectSession,
  linkStatus,
  connect,
  disconnect,
  linkTo,
  seedDemoPeers,
} from "../services/relay";
import {
  LAYOUT_PRESETS,
  type LayoutPreset,
} from "../services/layout-engine";
import { HelpTip } from "./HelpTip";
import { SettingsMenu } from "./SettingsMenu";

interface Props {
  layout: LayoutPreset;
  onLayoutChange: (preset: LayoutPreset) => void;
}

export function TitleBar(props: Props) {
  return (
    <div class="title-bar" data-tauri-drag-region>
      <div class="title-bar-left">
        <HelpTip
          title="TermGrid"
          description="Auto-tiling terminal with cross-device session linking. Drag this bar to move the window."
          badge={false}
        >
          <span class="app-title">TermGrid</span>
        </HelpTip>
      </div>

      <div class="title-bar-center">
        <div class="session-pills">
          <For each={remoteSessions()}>
            {(s) => (
              <HelpTip
                title={s.isLocal ? "This device" : s.name}
                description={
                  s.isLocal
                    ? `Your local terminal (${s.device}). ${s.paneCount} pane(s) open.`
                    : `Linked peer on ${s.device}. ${s.paneCount} pane(s). Click to view & control this device's terminals.`
                }
                shortcut={s.online ? "Online" : "Offline"}
                badge={false}
              >
                <button
                  class={`session-pill ${s.id === activeSession() ? "active" : ""} ${s.online ? "" : "offline"}`}
                  onClick={() => selectSession(s.id)}
                >
                  <span class={`status-dot ${s.online ? "on" : "off"}`} />
                  <span class="pill-name">{s.name}</span>
                  <span class="pill-count">{s.paneCount}</span>
                  <Show when={s.isLocal}>
                    <span class="pill-tag">local</span>
                  </Show>
                </button>
              </HelpTip>
            )}
          </For>
          <Show
            when={linkStatus() === "online"}
            fallback={
              <HelpTip
                title="Link this device"
                description="Starts a PeerJS session so other TermGrid instances can find and connect to you. Uses WebRTC P2P with the public broker by default."
              >
                <button
                  class="link-btn"
                  onClick={() => connect()}
                  disabled={linkStatus() === "connecting"}
                >
                  {linkStatus() === "connecting" ? "Linking…" : "+ Link devices"}
                </button>
              </HelpTip>
            }
          >
            <HelpTip
              title="Add a peer"
              description="Dial another device by its peer id. The id is shown in the status bar of that device."
            >
              <button
                class="link-btn"
                onClick={() => {
                  const id = prompt("Peer id to link:");
                  if (id) linkTo(id.trim());
                }}
              >
                + Add peer
              </button>
            </HelpTip>
            <HelpTip
              title="Unlink"
              description="Disconnect from all peers and stop being discoverable. Removes their pills from the title bar."
            >
              <button class="link-btn" onClick={disconnect}>Unlink</button>
            </HelpTip>
          </Show>
          <HelpTip
            title="Demo mode"
            description="Inject 3 mock peer sessions (Corporate Laptop, Personal Laptop, Home Server) for UI preview. No network traffic."
          >
            <button class="link-btn" onClick={seedDemoPeers}>Demo</button>
          </HelpTip>
        </div>
      </div>

      <div class="title-bar-right">
        <SettingsMenu />
        <div class="layout-picker">
          <For each={LAYOUT_PRESETS}>
            {(p) => (
              <HelpTip title={p.label} description={p.help} placement="bottom">
                <button
                  class={`layout-btn ${props.layout === p.id ? "active" : ""}`}
                  onClick={() => props.onLayoutChange(p.id)}
                >
                  <span class="layout-icon">{p.icon}</span>
                </button>
              </HelpTip>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
