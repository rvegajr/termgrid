import { Show } from "solid-js";
import { paneMetaMap } from "../services/pane-meta";
import { HelpTip } from "./HelpTip";

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

  const visible = () => !!(cwd() || branch() || shell());
  const dimmed = () => props.focused();

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
            <Show when={cwd()}>
              <span class="pl-cwd">{cwd()}</span>
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
