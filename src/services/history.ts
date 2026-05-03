import type { Terminal } from "@xterm/xterm";
import * as ipc from "./tauri-ipc";
import { paneMeta } from "./pane-meta";

/**
 * Per-pane command recorder.
 *
 * Two-tier strategy:
 *   1) OSC 133 (semantic prompt) — accurate, used when emitted:
 *        \x1b]133;C\x07     command begins
 *        \x1b]133;D;<exit>\x07   command ends
 *   2) Heuristic — buffer keystrokes between Enter presses; finalize on
 *      next prompt detection (via pane-meta cwd refresh signal).
 *
 * Calls history_record on the Tauri backend with the resulting row.
 */

interface RecorderState {
  paneId: string;
  sessionId: () => string;
  buf: string;
  lastCmd?: string;
  startedAt?: number;
  awaitingPrompt: boolean;
  oscMode: boolean; // true once we've seen any OSC 133 sequence
}

const recorders = new Map<string, RecorderState>();

export function attachRecorder(paneId: string, terminal: Terminal, sessionId: () => string) {
  const st: RecorderState = {
    paneId,
    sessionId,
    buf: "",
    awaitingPrompt: false,
    oscMode: false,
  };
  recorders.set(paneId, st);

  terminal.onData((data) => {
    // Buffer printable; on \r treat as command boundary.
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        if (st.buf.trim().length > 0) {
          st.lastCmd = st.buf;
          st.startedAt = Date.now();
          st.awaitingPrompt = !st.oscMode; // OSC mode handles this on its own
        }
        st.buf = "";
      } else if (ch === "\x7f" /* DEL */ || ch === "\b") {
        st.buf = st.buf.slice(0, -1);
      } else if (ch >= " ") {
        st.buf += ch;
      }
    }
  });
}

export function detachRecorder(paneId: string) {
  recorders.delete(paneId);
}

/**
 * Feed a chunk of raw PTY bytes (decoded text) to scan for OSC 133.
 * Should be invoked alongside `feedRaw` from pane-meta.
 */
export function feedHistoryRaw(paneId: string, text: string) {
  const st = recorders.get(paneId);
  if (!st) return;

  // OSC 133 ; C \x07  — command begins (we already buffered cmd)
  if (text.includes("\x1b]133;C\x07") || text.includes("\x1b]133;C\x1b\\")) {
    st.oscMode = true;
    if (st.lastCmd && st.startedAt === undefined) {
      st.startedAt = Date.now();
    }
  }

  // OSC 133 ; D ; <exit> \x07
  const dMatch = text.match(/\x1b\]133;D(?:;([+\-0-9]+))?(?:\x07|\x1b\\)/);
  if (dMatch && st.lastCmd) {
    st.oscMode = true;
    const exit = dMatch[1] ? parseInt(dMatch[1], 10) : undefined;
    finalize(st, exit);
    return;
  }

  // Heuristic finalize: if we're awaiting a prompt and pane-meta detected one,
  // record now. We approximate "prompt seen" by detecting the meta signal
  // change — but to keep this module decoupled we just check that some
  // prompt-like ending appears in this chunk.
  if (st.awaitingPrompt && /[\$#➜❯>]\s*$/.test(stripBasicAnsi(text).slice(-200))) {
    finalize(st, undefined);
  }
}

function finalize(st: RecorderState, exitCode: number | undefined) {
  if (!st.lastCmd) return;
  const meta = paneMeta(st.paneId);
  const startedAt = st.startedAt ?? Date.now();
  const row: ipc.HistoryRow = {
    pane_id: st.paneId,
    session_id: st.sessionId(),
    shell: meta.shell,
    cwd: meta.cwd,
    cmd: st.lastCmd,
    exit_code: exitCode,
    started_at: startedAt,
    duration_ms: Math.max(0, Date.now() - startedAt),
    source: "local",
  };
  ipc.historyRecord(row).catch((e) => console.warn("[history] record failed:", e));
  st.lastCmd = undefined;
  st.startedAt = undefined;
  st.awaitingPrompt = false;
}

function stripBasicAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
