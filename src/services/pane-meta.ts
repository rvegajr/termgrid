import { createSignal } from "solid-js";
import type { Terminal } from "@xterm/xterm";

export interface PaneMeta {
  cwd?: string;
  branch?: string;
  shell?: string;
  source: "osc" | "sniff" | "init";
}

const [metaMap, setMetaMap] = createSignal<Record<string, PaneMeta>>({});

export const paneMetaMap = metaMap;

export function paneMeta(paneId: string): PaneMeta {
  return metaMap()[paneId] ?? { source: "init" };
}

function patchMeta(paneId: string, patch: Partial<PaneMeta>) {
  setMetaMap((prev) => {
    const cur = prev[paneId] ?? { source: "init" };
    const next = { ...cur, ...patch };
    if (next.cwd === cur.cwd && next.branch === cur.branch && next.shell === cur.shell && next.source === cur.source) {
      return prev;
    }
    return { ...prev, [paneId]: next };
  });
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b[()][@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const PROMPT_CWD_RE = /(?:^|\n)[^\n]*?(?:╰[^\n]*[─-╿]+\s*)?([~/][^\s\n]+)\s*[$#➜❯>](?:\s|$)/;
const BRANCH_RE = /(?:\(|│|\s)((?:feat|fix|main|master|develop|release|hotfix|chore|docs|refactor)[\w./-]*)\)?/;
const BRANCH_FALLBACK = /[⎝┃\|\(\[]\s*([\w][\w./-]{0,40})\s*[\)\]⎝┃\|]/;

const OSC_RE = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

interface PaneBuf {
  buf: string;
  shell?: string;
}
const buffers = new Map<string, PaneBuf>();

const TAIL_BYTES = 4096;

export function attachMeta(paneId: string, terminal: Terminal, shell?: string) {
  buffers.set(paneId, { buf: "", shell });
  if (shell) patchMeta(paneId, { shell, source: "init" });

  // Tap parsed-write events; concat into a small tail buffer.
  terminal.onWriteParsed(() => {
    // We don't get the text directly here; we'll pull from terminal.buffer.
    refreshFromBuffer(paneId, terminal);
  });
}

export function detachMeta(paneId: string) {
  buffers.delete(paneId);
  setMetaMap((prev) => {
    if (!(paneId in prev)) return prev;
    const next = { ...prev };
    delete next[paneId];
    return next;
  });
}

/**
 * Feed raw bytes (pre-xterm-decode) for OSC sniffing. The byte path catches
 * OSC sequences before xterm potentially eats them.
 */
export function feedRaw(paneId: string, bytes: Uint8Array) {
  const text = utf8Decode(bytes);
  const cur = buffers.get(paneId);
  if (cur) {
    cur.buf = (cur.buf + text).slice(-TAIL_BYTES);
  }
  // Scan for OSC sequences and apply
  let m: RegExpExecArray | null;
  OSC_RE.lastIndex = 0;
  while ((m = OSC_RE.exec(text)) !== null) {
    handleOsc(paneId, m[1], m[2]);
  }
}

function handleOsc(paneId: string, code: string, payload: string) {
  if (code === "7") {
    // file://host/path → /path
    const path = payload.replace(/^file:\/\/[^/]*/, "");
    if (path) patchMeta(paneId, { cwd: prettyHome(path), source: "osc" });
  } else if (code === "1337") {
    // CurrentDir=/path  or  RemoteHost=…;CurrentDir=/path
    const parts = payload.split(";");
    for (const part of parts) {
      const [k, ...rest] = part.split("=");
      if (k.trim() === "CurrentDir") {
        const v = rest.join("=").trim();
        if (v) patchMeta(paneId, { cwd: prettyHome(v), source: "osc" });
      }
    }
  } else if (code === "133") {
    // OSC 133 ; A ; aid=… aas=<shell>
    const parts = payload.split(";");
    for (const part of parts) {
      const [k, v] = part.split("=");
      if (k && k.trim() === "aas" && v) patchMeta(paneId, { shell: v.trim(), source: "osc" });
    }
  }
}

function refreshFromBuffer(paneId: string, terminal: Terminal) {
  const meta = metaMap()[paneId];
  if (meta?.source === "osc") return; // OSC wins; skip sniff
  // Pull the last few visible lines from the active buffer.
  const buf = terminal.buffer.active;
  const start = Math.max(0, buf.length - 4);
  let tail = "";
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) tail += line.translateToString(true) + "\n";
  }
  const stripped = stripAnsi(tail);

  const cwdMatch = stripped.match(PROMPT_CWD_RE);
  if (cwdMatch && cwdMatch[1]) {
    patchMeta(paneId, { cwd: cwdMatch[1], source: "sniff" });
  }
  const branchMatch = stripped.match(BRANCH_RE) ?? stripped.match(BRANCH_FALLBACK);
  if (branchMatch && branchMatch[1] && branchMatch[1].length < 40) {
    patchMeta(paneId, { branch: branchMatch[1], source: "sniff" });
  }
}

function prettyHome(path: string): string {
  if (typeof navigator === "undefined") return path;
  // Best-effort shrink of /Users/foo or /home/foo → ~
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

// Exported regexes for reuse (Phase B uses the same prompt sniffer)
export const SNIFF_REGEXES = {
  promptCwd: PROMPT_CWD_RE,
  branch: BRANCH_RE,
  branchFallback: BRANCH_FALLBACK,
  ansi: ANSI_RE,
  osc: OSC_RE,
};
