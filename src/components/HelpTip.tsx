import { JSX, Show } from "solid-js";

interface Props {
  title: string;
  description: string;
  shortcut?: string;
  placement?: "bottom" | "top" | "right" | "left";
  badge?: boolean; // show the little "?" corner mark (default true)
  children: JSX.Element;
}

/**
 * Wraps any interactive element with a hover help card.
 * - Shows a tiny "?" badge in the top-right corner of the wrapped element.
 * - On hover, shows a richer card with title + description (and optional shortcut).
 */
export function HelpTip(props: Props) {
  const place = () => props.placement ?? "bottom";
  const showBadge = () => props.badge !== false;
  return (
    <span class="help-wrap" data-place={place()}>
      {props.children}
      <Show when={showBadge()}>
        <span class="help-badge" aria-hidden="true">?</span>
      </Show>
      <span class="help-card" role="tooltip">
        <span class="help-title">{props.title}</span>
        <span class="help-desc">{props.description}</span>
        <Show when={props.shortcut}>
          <span class="help-shortcut">{props.shortcut}</span>
        </Show>
      </span>
    </span>
  );
}
