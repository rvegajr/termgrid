/**
 * Centralized pane resource disposal.
 * Extracted to deduplicate the teardown logic across closeActivePane, closeTab, and loadTemplateLayout.
 */

import type { Terminal } from "@xterm/xterm";
import type { SnapshotHandle } from "./pane-snapshot";
import * as ipc from "./tauri-ipc";
import { detachMeta } from "./pane-meta";
import { forgetPaneHost } from "./pane-host";
import { detachRecorder } from "./history";
import { forgetPaneId } from "./pane-snapshot";

export interface DisposablePaneState {
  backendId: string;
  stableId: string;
  terminal: Terminal;
  snapshot: SnapshotHandle;
  resizeObserver?: ResizeObserver;
}

export interface DisposeDeps {
  paneEls: Map<string, HTMLDivElement>;
  closedStableIds: Set<string>;
}

/**
 * Dispose all resources associated with a pane.
 * Call this from every pane-close path to ensure no leaks.
 */
export async function disposePaneResources(
  pane: DisposablePaneState,
  deps: DisposeDeps
): Promise<void> {
  // Mark as explicitly closed (authorizes removal from persistence)
  deps.closedStableIds.add(pane.stableId);
  
  // Disconnect resize observer (prevents DOM/closure leak)
  pane.resizeObserver?.disconnect();
  
  // Destroy snapshot (flushes + deletes from disk)
  await pane.snapshot.destroy(true);
  
  // Detach all service hooks
  detachMeta(pane.backendId);
  forgetPaneHost(pane.backendId);
  detachRecorder(pane.backendId);
  forgetPaneId(pane.stableId);
  
  // Remove from paneEls map
  deps.paneEls.delete(pane.backendId);
  
  // Dispose terminal (frees xterm resources)
  pane.terminal.dispose();
  
  // Close backend PTY
  await ipc.closePane(pane.backendId);
}
