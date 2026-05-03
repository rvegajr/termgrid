// relay.js — the ONLY file that handles cross-device communication.
//
// Transport: PeerJS (WebRTC P2P with a signaling broker).
//  - Default: the free public PeerJS broker + STUN.
//  - For corporate-firewall traversal, point RELAY_HOST/RELAY_PORT at a
//    self-hosted PeerJS server (same API — swap URL, no other code changes).
//
// Wire protocol (over one DataConnection per peer):
//   { type: "hello",  session }
//   { type: "state",  session }                      // periodic pane-count update
//   { type: "panes",  panes: [{paneId, label?}] }    // host's pane list snapshot
//   { type: "input",  paneId, data }                 // remote typing into a pane
//   { type: "output", paneId, data }                 // pane output stream (base64)
//   { type: "bye" }
//
// Security note: read-only mirroring is the default. Anyone who guesses your
// peer id can subscribe to your output. A pairing-token + libsodium upgrade is
// flagged as Phase E in plan; not yet implemented.
//
// Everything else in the app imports from here. Keep it one file.

import Peer from "peerjs";
import { createSignal } from "solid-js";

// --- config -----------------------------------------------------------------
// Swap these to self-host PeerJS for corporate networks.
const RELAY_HOST = undefined; // e.g. "relay.example.com"
const RELAY_PORT = undefined; // e.g. 9000
const RELAY_PATH = "/termgrid";

// --- solid signals (consumed by the UI) -------------------------------------
const localId = stableDeviceId();

const [sessions, setSessions] = createSignal([
  {
    id: localId,
    name: "This device",
    device: inferDeviceName(),
    paneCount: 0,
    online: true,
    isLocal: true,
  },
]);
const [activeId, setActiveId] = createSignal(localId);
const [status, setStatus] = createSignal("offline"); // "offline" | "connecting" | "online"

export const remoteSessions = sessions;
export const activeSession = activeId;
export const linkStatus = status;

// --- remote-pane snapshots (per peer) --------------------------------------
const [remotePanesMap, setRemotePanesMap] = createSignal({});
export const remotePanes = remotePanesMap;
/** Returns the array of pane descriptors most recently advertised by `peerId`. */
export function panesFor(peerId) {
  return remotePanesMap()[peerId] ?? [];
}

// --- peer state -------------------------------------------------------------
let peer = null;
const connections = new Map();
const inputHandlers = new Set();
const outputHandlers = new Set();
const panesHandlers = new Set();

// --- public API -------------------------------------------------------------

/** Start PeerJS, publish our session, become discoverable. */
export function connect(name = "This device") {
  if (peer) return;
  setStatus("connecting");
  const opts = RELAY_HOST
    ? { host: RELAY_HOST, port: RELAY_PORT, path: RELAY_PATH, secure: true }
    : undefined;
  peer = new Peer(localId, opts);

  peer.on("open", () => {
    setStatus("online");
    updateLocalSession({ name });
  });
  peer.on("connection", (conn) => attachConnection(conn));
  peer.on("error", (err) => {
    console.warn("[relay] peer error:", err);
    if (err && err.type === "peer-unavailable") return; // benign
    setStatus("offline");
  });
  peer.on("disconnected", () => setStatus("offline"));
}

/** Dial a specific peer id. */
export function linkTo(peerId) {
  if (!peer || peerId === localId || connections.has(peerId)) return;
  const conn = peer.connect(peerId, { reliable: true });
  attachConnection(conn);
}

/** Tear everything down. */
export function disconnect() {
  for (const c of connections.values()) safeSend(c, { type: "bye" });
  connections.clear();
  if (peer) peer.destroy();
  peer = null;
  setStatus("offline");
  setSessions((prev) => prev.filter((s) => s.isLocal));
  setActiveId(localId);
}

export function selectSession(id) {
  if (sessions().some((s) => s.id === id)) setActiveId(id);
}

/** Call when local pane count / name changes — broadcasts to all peers. */
export function updateLocalSession(patch) {
  setSessions((prev) => prev.map((s) => (s.isLocal ? { ...s, ...patch } : s)));
  const me = sessions().find((s) => s.isLocal);
  if (me) broadcast({ type: "state", session: me });
}

/** Forward local keystrokes for a pane to the active remote session. */
export function sendInput(paneId, data) {
  const target = activeId();
  if (target === localId) return;
  const conn = connections.get(target);
  if (conn) safeSend(conn, { type: "input", paneId, data });
}

/** Forward pane output bytes to all linked peers — used when hosting. */
export function broadcastOutput(paneId, bytes) {
  broadcast({ type: "output", paneId, data: bytesToB64(bytes) });
}

/** Advertise our current pane list — descriptors only, no terminal contents. */
export function broadcastPanes(panes) {
  broadcast({ type: "panes", panes });
}

export function onRemoteInput(fn) {
  inputHandlers.add(fn);
  return () => inputHandlers.delete(fn);
}
export function onRemoteOutput(fn) {
  outputHandlers.add(fn);
  return () => outputHandlers.delete(fn);
}
export function onRemotePanes(fn) {
  panesHandlers.add(fn);
  return () => panesHandlers.delete(fn);
}

// --- base64 helpers ---------------------------------------------------------
function bytesToB64(bytes) {
  if (typeof bytes === "string") return bytes; // already encoded by caller
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return btoa(s); } catch { return ""; }
}
export function b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

export function localPeerId() {
  return localId;
}

/** Inject mock peer sessions — for UI demo only, no network traffic. */
export function seedDemoPeers() {
  setStatus("online");
  setSessions((prev) => {
    const mocks = [
      { id: "demo-corp", name: "Corporate Laptop", device: "work-mbp", paneCount: 4, online: true,  isLocal: false },
      { id: "demo-home", name: "Personal Laptop",  device: "home-mbp", paneCount: 5, online: true,  isLocal: false },
      { id: "demo-serv", name: "Home Server",      device: "linux",    paneCount: 2, online: false, isLocal: false },
    ];
    const keep = prev.filter((s) => !s.id.startsWith("demo-"));
    return [...keep, ...mocks];
  });
}

// --- internals --------------------------------------------------------------

function attachConnection(conn) {
  conn.on("open", () => {
    connections.set(conn.peer, conn);
    const me = sessions().find((s) => s.isLocal);
    if (me) safeSend(conn, { type: "hello", session: me });
  });
  conn.on("data", (raw) => handleMessage(conn.peer, raw));
  conn.on("close", () => {
    connections.delete(conn.peer);
    setSessions((prev) => prev.filter((s) => s.id !== conn.peer));
    setRemotePanesMap((prev) => {
      if (!(conn.peer in prev)) return prev;
      const next = { ...prev };
      delete next[conn.peer];
      return next;
    });
    if (activeId() === conn.peer) setActiveId(localId);
  });
  conn.on("error", (e) => console.warn("[relay] conn error:", e));
}

function handleMessage(fromId, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello":
    case "state": {
      setSessions((prev) => {
        const s = { ...msg.session, id: fromId, isLocal: false, online: true };
        const idx = prev.findIndex((p) => p.id === fromId);
        if (idx === -1) return [...prev, s];
        const next = [...prev];
        next[idx] = s;
        return next;
      });
      return;
    }
    case "input":
      inputHandlers.forEach((h) => h(msg.paneId, msg.data));
      return;
    case "output":
      outputHandlers.forEach((h) => h(fromId, msg.paneId, msg.data));
      return;
    case "panes": {
      const list = Array.isArray(msg.panes) ? msg.panes : [];
      setRemotePanesMap((prev) => ({ ...prev, [fromId]: list }));
      panesHandlers.forEach((h) => h(fromId, list));
      return;
    }
    case "bye": {
      const c = connections.get(fromId);
      if (c) c.close();
      return;
    }
  }
}

function broadcast(msg) {
  for (const c of connections.values()) safeSend(c, msg);
}
function safeSend(c, msg) {
  try { c.send(msg); } catch (e) { console.warn("[relay] send failed:", e); }
}

function stableDeviceId() {
  const key = "termgrid.peerId";
  try {
    const cached = localStorage.getItem(key);
    if (cached) return cached;
    const id = "tg-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, id);
    return id;
  } catch {
    return "tg-" + Math.random().toString(36).slice(2, 10);
  }
}

function inferDeviceName() {
  if (typeof navigator === "undefined") return "local";
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Linux")) return "linux";
  return "local";
}
