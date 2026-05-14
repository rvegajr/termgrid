import { Show, createSignal } from "solid-js";
import { paneMetaMap } from "../services/pane-meta";
import { paneHostMap } from "../services/pane-host";
import { HelpTip } from "./HelpTip";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as pinnedDirs from "../services/pinned-dirs";

interface Props {
  paneId: string;
  shellHint?: string;
  focused: () => boolean;
}

export function PaneLabel(props: Props) {
  const meta = () => paneMetaMap()[props.paneId];
  const cwd = () => meta()?.cwd;
  const branch = () => meta()?.branch;
  const shell = () => meta()?.shell ?? props.shellHint;
  const source = () => meta()?.source ?? "init";
  const host = () => paneHostMap()[props.paneId];

  const visible = () => !!(cwd() || branch() || shell() || host());
  const dimmed = () => props.focused();
  const [isPinnedDir, setIsPinnedDir] = createSignal(false);

  // Check if current CWD is pinned
  const checkPinned = async () => {
    const cwdPath = cwd();
    if (!cwdPath) return;
    const pinned = await pinnedDirs.isPinned(cwdPath);
    setIsPinnedDir(pinned);
  };

  // Re-check when CWD changes
  const cwdValue = cwd();
  if (cwdValue) {
    checkPinned();
  }

  const handleRevealInFinder = async (e: MouseEvent) => {
    e.stopPropagation();
    const cwdPath = cwd();
    if (!cwdPath) return;
    
    try {
      await revealItemInDir(cwdPath);
    } catch (err) {
      console.error("Failed to reveal directory:", cwdPath, err);
    }
  };

  const handleTogglePin = async (e: MouseEvent) => {
    e.stopPropagation();
    const cwdPath = cwd();
    if (!cwdPath) return;
    
    try {
      if (isPinnedDir()) {
        await pinnedDirs.unpinDir(cwdPath);
        setIsPinnedDir(false);
      } else {
        await pinnedDirs.pinDir(cwdPath);
        setIsPinnedDir(true);
      }
      // Dispatch event to refresh pinned dirs list in App.tsx
      window.dispatchEvent(new CustomEvent("pinned-dirs-changed"));
    } catch (err) {
      console.error("Failed to toggle pin:", cwdPath, err);
    }
  };

  return (
    <Show when={visible()}>
      <div class={`pane-label ${dimmed() ? "dim" : ""}`} data-source={source()}>
        <HelpTip
          title="Pane label"
          description={
            source() === "osc"
              ? "Detected from OSC 7 / OSC 133 escape sequences emitted by your shell. 100% accurate."
              : source() === "sniff"
              ? "Auto-sniffed from your terminal prompt (~80% accurate). Add an OSC 7 hook to .zshrc / .bashrc for perfect labels."
              : "Initial label from shell metadata. Will refine once a prompt is detected."
          }
          placement="left"
          badge={false}
        >
          <span class="pane-label-row">
            <Show when={host()}>
              <span class={`pl-host ${host()!.kind === "ssh" ? "ssh" : "local"}`}>
                {host()!.kind === "ssh"
                  ? `ssh → ${(host() as { kind: "ssh"; destination: string }).destination}`
                  : (host() as { kind: "local"; host: string }).host}
              </span>
              <Show when={cwd() || branch() || shell()}>
                <span class="pl-sep">·</span>
              </Show>
            </Show>
            <Show when={cwd()}>
              <span class="pl-cwd">{cwd()}</span>
              <button
                class="pl-pin-btn"
                onClick={handleTogglePin}
                title={isPinnedDir() ? "Unpin directory" : "Pin directory"}
              >
                {isPinnedDir() ? "📌" : "📍"}
              </button>
              <button
                class="pl-reveal-btn"
                onClick={handleRevealInFinder}
                title="Reveal in Finder"
              >
                📂
              </button>
            </Show>
            <Show when={branch()}>
              <span class="pl-sep">·</span>
              <span class="pl-branch">{branch()}</span>
            </Show>
            <Show when={shell()}>
              <span class="pl-sep">·</span>
              <span class="pl-shell">{shell()}</span>
            </Show>
            <span class={`pl-source-dot ${source()}`} />
          </span>
        </HelpTip>
      </div>
    </Show>
  );
}
