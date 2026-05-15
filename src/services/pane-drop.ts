/**
 * Drop handlers for terminal panes.
 *
 * Behavior matches iTerm2 / Terminal.app: a drop **pastes** — never
 * executes. The user presses Enter themselves. Paths are shell-quoted so
 * spaces and special characters survive.
 *
 * Two kinds of drops are wired by App.tsx:
 *
 *   1. **Text drag-drop** (HTML5 `ondrop` on each pane's container) — for
 *      text selected in another app, or from the same TermGrid window.
 *      The Tauri webview delivers these as normal HTML events.
 *
 *   2. **File / folder drag-drop** (Tauri `onDragDropEvent` on the window) —
 *      Tauri intercepts file drops before the webview sees them and gives
 *      us actual filesystem paths plus the drop position. The window-level
 *      listener hit-tests `position` against pane DOM bounds to route the
 *      drop to the right pane.
 */

/**
 * POSIX-safe shell-quote a single path. Idempotent under our own input
 * (we always emit a quoted form), so re-quoting is a no-op.
 *
 * Windows paths use double-quotes (cmd / PowerShell both honor them).
 * Embedded double-quotes are doubled (`""`), the SDK convention shared
 * by cmd, PowerShell, and most Windows CLIs.
 *
 * Why not let the shell handle it? Because the user is *pasting*, not
 * typing — they'd expect the path to be ready to use as a single arg.
 */
export function quoteShellPath(path: string): string {
  if (typeof navigator !== "undefined" && /Win/i.test(navigator.platform)) {
    return `"${path.replace(/"/g, '""')}"`;
  }
  // POSIX single-quote: literal everything inside except `'` itself, which
  // is rendered as `'\''` (close, literal-quote, reopen).
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Join multiple paths with single spaces, each individually quoted, for
 * the typical "drop a few files" case. Caller decides whether to append
 * a leading space when concatenating to whatever the pane already has on
 * its prompt line.
 */
export function quoteShellPaths(paths: string[]): string {
  return paths.map(quoteShellPath).join(" ");
}

/**
 * Hit-test a (logical-pixel) point against a list of candidate elements.
 * Used to figure out which pane the user dropped a file on.
 *
 * Returns the matching element's id (data attribute / id), or `null` if
 * the point fell outside every candidate. Caller passes a function that
 * returns the candidate's stable id for routing.
 */
export function findElementAtPoint<T>(
  x: number,
  y: number,
  candidates: Iterable<{ el: HTMLElement; payload: T }>,
): T | null {
  for (const { el, payload } of candidates) {
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return payload;
    }
  }
  return null;
}
