/**
 * Auto-updater wrapper around tauri-plugin-updater.
 *
 * Status: scaffolded but DORMANT. The plugin's `active` flag is false in
 * tauri.conf.json until you:
 *   1. Generate a signing keypair: `pnpm tauri signer generate`
 *   2. Paste the public key into tauri.conf.json → plugins.updater.pubkey
 *   3. Add the private key to GitHub Secrets as TAURI_SIGNING_PRIVATE_KEY
 *      (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD if you set one)
 *   4. Set `active: true` in tauri.conf.json
 *   5. Wire your release pipeline to publish a `latest.json` manifest at the
 *      configured endpoint (see RELEASING.md).
 *
 * Once enabled, call `checkForUpdate()` from the UI (e.g. a menu item) or
 * automatically at app startup.
 */

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "ready" }
  | { kind: "up-to-date" }
  | { kind: "error"; message: string };

export type UpdateListener = (s: UpdateState) => void;

export async function checkForUpdate(onState?: UpdateListener): Promise<void> {
  onState?.({ kind: "checking" });
  try {
    const upd = await check();
    if (!upd) {
      onState?.({ kind: "up-to-date" });
      return;
    }
    onState?.({ kind: "available", version: upd.version, notes: upd.body });

    let downloaded = 0;
    let total = 0;
    await upd.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onState?.({ kind: "downloading", received: downloaded, total });
          break;
        case "Finished":
          onState?.({ kind: "ready" });
          break;
      }
    });

    // Apply: relaunch the app to use the new bits.
    await relaunch();
  } catch (e: any) {
    onState?.({ kind: "error", message: String(e?.message ?? e) });
  }
}
