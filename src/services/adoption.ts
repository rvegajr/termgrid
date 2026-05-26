/**
 * Session adoption — typed wrappers around the Rust `adoption::commands`
 * IPC surface. Pure transport: no caching, no UI state, no policy.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * One row in the picker. Mirrors `adoption::types::AdoptableSession` on
 * the Rust side. Kept lightweight on purpose — the heavier
 * {@link SessionSnapshot} is fetched only after the user makes a choice.
 */
export interface AdoptableSession {
  pid: number;
  shell: string;
  cwd: string | null;
  tty: string | null;
  parent: string | null;
  last_command: string | null;
  /** Unix seconds. */
  started_at: number;
  via_ssh: boolean;
}

/**
 * One captured environment variable from a foreign process.
 * Filtered through the Rust-side allow-list before reaching us.
 */
export interface EnvVar {
  name: string;
  value: string;
}

/**
 * Parsed ssh invocation for `via_ssh: true` rows.
 * Powers the "Reconnect to remote" UX in v2.
 */
export interface SshTarget {
  /** `user@host` or just `host`. */
  destination: string;
  port: number | null;
  /** Optional trailing remote command (e.g. `htop -d 5`). */
  command: string | null;
  /** Full argv as parsed from `ps -o args=`. */
  argv: string[];
}

/**
 * Full payload for one adopted session. Mirrors
 * `adoption::types::SessionSnapshot`. Used to seed CWD, banner, history,
 * environment, and (v2) buffer preview / ssh target of the new pane.
 */
export interface SessionSnapshot {
  pid: number;
  shell: string;
  cwd: string | null;
  tty: string | null;
  /** Oldest-first; may be empty if history is unreadable. */
  recent_history: string[];
  banner: string;
  /** v2: visible terminal contents from the host app, if scrapable. */
  buffer_preview: string | null;
  /** v2: filtered toolchain env vars; empty if probe denied. */
  env_vars: EnvVar[];
  /** v2: parsed ssh invocation for reconnect; null for non-ssh shells. */
  ssh_target: SshTarget | null;
}

/**
 * Where the adopted session should land. Determines whether
 * `App.tsx::adoptSession` opens a new tab, retrofits the active pane,
 * or splits the active tab.
 */
export type AdoptionMode = "new-tab" | "active-pane" | "split";

/**
 * What kind of seeding logic to apply once the pane exists. v2 adds the
 * SSH reconnect path which dispatches `ssh user@host` rather than `cd`.
 */
export type AdoptionStrategy = "local-cwd" | "ssh-reconnect";

/**
 * List every adoptable shell on the host.
 *
 * Discovery is synchronous-fast on the Rust side (under 100ms for typical
 * process counts), so we don't bother with streaming.
 */
export async function listAdoptableSessions(): Promise<AdoptableSession[]> {
  return invoke<AdoptableSession[]>("list_adoptable_sessions_cmd");
}

/**
 * Fetch the full snapshot for one picked session.
 *
 * Always resolves with a payload even if the target process exited
 * (fields will be empty/best-effort). Callers should still open the
 * pane — the snapshot itself is a guide, not a contract.
 */
export async function snapshotSession(pid: number): Promise<SessionSnapshot> {
  return invoke<SessionSnapshot>("snapshot_session_cmd", { pid });
}

/**
 * **v3:** Ask the backend which terminal-host app is currently in front.
 * Used by the "Adopt frontmost terminal" palette action so the picker
 * can pre-filter to that app's child shells.
 *
 * Returns `null` when the OS denied the probe, no app is foreground, or
 * the active app is TermGrid itself.
 */
export async function frontmostTerminalApp(): Promise<string | null> {
  const out = await invoke<string | null>("frontmost_terminal_app_cmd");
  return out ?? null;
}

/**
 * **v4:** Result of {@link snapToFrontmost}. Mirrors the Rust enum
 * `SnapResult` (tag = `"kind"`). Discriminated union — the frontend
 * switches on `kind` to render the right path.
 */
export type SnapResult =
  | { kind: "none"; reason: string }
  | {
      kind: "one";
      host: string;
      session: AdoptableSession;
      snapshot: SessionSnapshot;
    }
  | {
      kind: "multiple";
      host: string;
      candidates: AdoptableSession[];
    };

/**
 * **v4:** One-shot adoption of the user's currently focused terminal.
 *
 * Behavior tiers:
 *   - `none` — no recognizable terminal in front; UI should surface a
 *     small toast with `reason`.
 *   - `one` — exactly one candidate; UI should call `onPick` directly.
 *   - `multiple` — multiple candidates; UI should open the picker
 *     pre-filtered by `host`.
 *
 * Costs ~150 ms on macOS (one AppleScript call + sysinfo scan). We
 * never call this proactively — only in response to the user's hotkey
 * / palette action.
 */
export async function snapToFrontmost(): Promise<SnapResult> {
  return invoke<SnapResult>("snap_to_frontmost_cmd");
}

/**
 * **v4:** macOS env-replay fallback. Spawns a login shell in `cwd` and
 * returns the allow-listed env vars it sees — catches direnv/asdf/mise
 * even when the direct env probe is sandboxed.
 *
 * The picker calls this lazily on snapshot fetch when the direct probe
 * returned empty; the result is cached in {@link snapshotCache}.
 */
export async function replayEnvInCwd(
  shell: string,
  cwd: string,
): Promise<EnvVar[]> {
  return invoke<EnvVar[]>("replay_env_in_cwd_cmd", { shell, cwd });
}

/** **v4:** Opt-in clipboard-capture for terminal hosts we can't scrape. */
export interface ClipboardCapture {
  text: string | null;
  reason: string | null;
}
export async function clipboardCapture(): Promise<ClipboardCapture> {
  return invoke<ClipboardCapture>("clipboard_capture_cmd");
}

/**
 * **v3:** Process-snapshot cache keyed by PID.
 *
 * `AdoptionPicker` populates this as the user hovers/keyboard-navigates
 * rows so that re-selecting a row (or scrolling back to it) is instant.
 * Entries expire after `MAX_AGE_MS` so we don't serve stale buffer
 * previews of a session whose state moved on.
 *
 * Designed to live across picker open/close cycles (it's a module-level
 * Map). Callers can `clear()` it when they explicitly want a fresh read
 * (e.g. when the user hits "Rescan").
 */
const MAX_AGE_MS = 30_000;
const snapshotCache = new Map<number, { at: number; snap: SessionSnapshot }>();

export function getCachedSnapshot(pid: number): SessionSnapshot | null {
  const hit = snapshotCache.get(pid);
  if (!hit) return null;
  if (Date.now() - hit.at > MAX_AGE_MS) {
    snapshotCache.delete(pid);
    return null;
  }
  return hit.snap;
}

export function rememberSnapshot(pid: number, snap: SessionSnapshot): void {
  snapshotCache.set(pid, { at: Date.now(), snap });
}

export function clearSnapshotCache(): void {
  snapshotCache.clear();
}

/**
 * Cached variant of {@link snapshotSession}. Returns the cached snapshot
 * if fresh, else fetches + caches + returns. Same shape either way.
 */
export async function snapshotSessionCached(
  pid: number,
): Promise<SessionSnapshot> {
  const cached = getCachedSnapshot(pid);
  if (cached) return cached;
  const fresh = await snapshotSession(pid);
  rememberSnapshot(pid, fresh);
  return fresh;
}

/**
 * **v3:** Diff two adoption-row lists by PID + started_at.
 *
 * Returns the PIDs that appear in `prev` but not in `next` — i.e.
 * sessions that vanished between polls. The picker uses this to fade
 * those rows out before removing them from the list, giving a small but
 * meaningful "still scanning" signal.
 *
 * Why include `started_at`: PIDs are reused on Linux. A PID that
 * disappears and is immediately reassigned by the OS would otherwise
 * look like a continuous row even though it's a wholly different shell.
 * Matching `(pid, started_at)` makes the diff robust to that case.
 */
export function diffStaleRows(
  prev: AdoptableSession[],
  next: AdoptableSession[],
): number[] {
  const key = (s: AdoptableSession) => `${s.pid}:${s.started_at}`;
  const nextKeys = new Set(next.map(key));
  return prev.filter((p) => !nextKeys.has(key(p))).map((p) => p.pid);
}

/**
 * Heuristic for "is this candidate a system shell, not a user shell"?
 * System shells are descended from PID 1 with no terminal host attached
 * and no TTY. The picker hides them by default behind a toggle so they
 * don't bury the user's actual interactive sessions.
 *
 * We approximate "system" with: no `tty`, no `parent` (terminal host),
 * and a CWD of `/` (the typical daemon CWD). This catches `mdmclient`,
 * `securityd`-style children, init scripts, etc. without false-flagging
 * a real shell that happens to be backgrounded.
 */
export function isLikelySystemShell(s: AdoptableSession): boolean {
  if (s.tty) return false;
  if (s.parent) return false;
  if (s.cwd && s.cwd !== "/" && s.cwd !== "/private/var/root") return false;
  return true;
}

/**
 * Render the reconnect command for an SSH session. Mirrors the Rust-side
 * `ssh_parse::render_reconnect_command` so we can show the user exactly
 * what we'll execute on their behalf.
 *
 * **v3:** When `sendEnv` is non-empty, emit `-o SendEnv=NAME` flags so
 * the local shell's allow-listed toolchain vars survive the ssh hop. The
 * remote sshd must allow each name in its `AcceptEnv` config; failures
 * are silent (ssh just doesn't forward), so this is a safe enhancement.
 */
export function renderSshReconnect(
  target: SshTarget,
  sendEnv: string[] = [],
): string {
  const parts: string[] = ["ssh"];
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const name of sendEnv.slice(0, 16)) {
    if (validName.test(name)) {
      parts.push("-o", `SendEnv=${name}`);
    }
  }
  if (target.port !== null && target.port !== undefined) {
    parts.push("-p", String(target.port));
  }
  parts.push(target.destination);
  if (target.command) {
    parts.push(target.command);
  }
  return parts.join(" ");
}

/**
 * Format an SSH target for one-line display in the picker.
 * Returns `null` when no destination is present (defensive — Rust-side
 * parser already guarantees a non-empty destination on success).
 */
export function describeSshTarget(target: SshTarget | null): string | null {
  if (!target || !target.destination) return null;
  const portTag = target.port ? `:${target.port}` : "";
  return `${target.destination}${portTag}`;
}

/**
 * Human-readable "age" of a process given its Unix start time.
 *
 * Returns short, picker-friendly strings: `"just now"`, `"3m"`,
 * `"2h"`, `"4d"`. Anything older than 30 days collapses to `"30d+"`
 * to keep the column narrow.
 */
export function formatAge(startedAt: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const secs = Math.max(0, nowSec - startedAt);
  if (secs < 30) return "just now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return "30d+";
}

export interface InstallPluginsResult {
  success: boolean;
  plugins_dir: string;
  instructions: string;
}

/** **v5:** Install TermGrid shell plugins to `~/.termgrid/plugins/`. */
export async function installShellPlugins(): Promise<InstallPluginsResult> {
  return invoke("install_shell_plugins_cmd");
}

/**
 * **v5:** Where a pane currently "thinks it is" — local, or remoted via
 * ssh/mosh. Mirrors `commands::RemoteContext` (tagged union, kebab-case).
 */
export type RemoteContext =
  | { kind: "local"; host: string }
  | { kind: "ssh"; destination: string; host: string; port: number | null };

export async function paneRemoteContext(
  paneId: string,
): Promise<RemoteContext | null> {
  return invoke<RemoteContext | null>("pane_remote_context", { paneId });
}
