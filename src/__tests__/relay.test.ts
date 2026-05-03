import { describe, it, expect, beforeEach, vi } from "vitest";

// -- mock peerjs before importing relay -------------------------------------
type Handler = (...args: any[]) => void;

class FakeConn {
  peer: string;
  private handlers: Record<string, Handler[]> = {};
  sent: any[] = [];
  constructor(peer: string) { this.peer = peer; }
  on(ev: string, h: Handler) { (this.handlers[ev] ??= []).push(h); }
  send(msg: any) { this.sent.push(msg); }
  close() { this.emit("close"); }
  emit(ev: string, ...args: any[]) { (this.handlers[ev] ?? []).forEach((h) => h(...args)); }
}

class FakePeer {
  id: string;
  private handlers: Record<string, Handler[]> = {};
  destroyed = false;
  static last: FakePeer | null = null;
  constructor(id: string) { this.id = id; FakePeer.last = this; queueMicrotask(() => this.emit("open", id)); }
  on(ev: string, h: Handler) { (this.handlers[ev] ??= []).push(h); }
  connect(peerId: string) {
    const c = new FakeConn(peerId);
    queueMicrotask(() => c.emit("open"));
    return c as any;
  }
  destroy() { this.destroyed = true; }
  emit(ev: string, ...args: any[]) { (this.handlers[ev] ?? []).forEach((h) => h(...args)); }
  inbound(peerId: string) { const c = new FakeConn(peerId); this.emit("connection", c); return c; }
}

vi.mock("peerjs", () => ({ default: FakePeer }));

// fresh module per test so internal state resets
async function loadRelay() {
  vi.resetModules();
  try { localStorage.clear?.(); } catch {}
  FakePeer.last = null;
  return await import("../services/relay.js");
}

const flush = () => new Promise((r) => queueMicrotask(() => r(null)));

describe("relay", () => {
  beforeEach(() => { try { localStorage.clear?.(); } catch {} });

  it("starts offline with a single local session", async () => {
    const r = await loadRelay();
    expect(r.linkStatus()).toBe("offline");
    const s = r.remoteSessions();
    expect(s).toHaveLength(1);
    expect(s[0].isLocal).toBe(true);
    expect(r.activeSession()).toBe(s[0].id);
  });

  it("connect() transitions offline → connecting → online", async () => {
    const r = await loadRelay();
    r.connect();
    expect(r.linkStatus()).toBe("connecting");
    await flush();
    expect(r.linkStatus()).toBe("online");
  });

  it("assigns a stable peer id across reloads", async () => {
    const store = new Map<string, string>();
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    vi.stubGlobal("localStorage", ls);
    vi.resetModules();
    FakePeer.last = null;
    const r1 = await import("../services/relay.js");
    const id1 = r1.remoteSessions()[0].id;
    vi.resetModules();
    const r2 = await import("../services/relay.js");
    expect(r2.remoteSessions()[0].id).toBe(id1);
    vi.unstubAllGlobals();
  });

  it("seedDemoPeers injects 3 mock peers and marks online", async () => {
    const r = await loadRelay();
    r.seedDemoPeers();
    const ids = r.remoteSessions().map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["demo-corp", "demo-home", "demo-serv"]));
    expect(r.linkStatus()).toBe("online");
  });

  it("seedDemoPeers is idempotent (no duplicates on repeat)", async () => {
    const r = await loadRelay();
    r.seedDemoPeers();
    r.seedDemoPeers();
    expect(r.remoteSessions().filter((s: any) => s.id.startsWith("demo-"))).toHaveLength(3);
  });

  it("selectSession ignores unknown ids", async () => {
    const r = await loadRelay();
    const before = r.activeSession();
    r.selectSession("nope");
    expect(r.activeSession()).toBe(before);
    r.seedDemoPeers();
    r.selectSession("demo-corp");
    expect(r.activeSession()).toBe("demo-corp");
  });

  it("hello from remote registers a non-local session", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    conn.emit("data", {
      type: "hello",
      session: { id: "ignored", name: "Corp", device: "mac", paneCount: 3, online: true, isLocal: true },
    });
    const corp = r.remoteSessions().find((s: any) => s.id === "remote-1");
    expect(corp).toBeDefined();
    expect(corp!.isLocal).toBe(false); // always forced false for incoming
    expect(corp!.paneCount).toBe(3);
  });

  it("state message updates an existing peer in place (no duplicate)", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    conn.emit("data", { type: "hello", session: { id: "x", name: "A", device: "mac", paneCount: 1, online: true, isLocal: false } });
    conn.emit("data", { type: "state", session: { id: "x", name: "A", device: "mac", paneCount: 7, online: true, isLocal: false } });
    const matches = r.remoteSessions().filter((s: any) => s.id === "remote-1");
    expect(matches).toHaveLength(1);
    expect(matches[0].paneCount).toBe(7);
  });

  it("updateLocalSession patches local and broadcasts state to peers", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    await flush();
    conn.sent.length = 0;
    r.updateLocalSession({ paneCount: 9 });
    const stateMsgs = conn.sent.filter((m: any) => m.type === "state");
    expect(stateMsgs.length).toBeGreaterThan(0);
    expect(stateMsgs[stateMsgs.length - 1].session.paneCount).toBe(9);
  });

  it("sendInput only fires when active session is remote", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    await flush();
    conn.sent.length = 0;

    r.sendInput("pane-0", "ls\n");              // active=local → drop
    expect(conn.sent.some((m: any) => m.type === "input")).toBe(false);

    conn.emit("data", { type: "hello", session: { id: "x", name: "C", device: "mac", paneCount: 1, online: true, isLocal: false } });
    r.selectSession("remote-1");
    r.sendInput("pane-0", "ls\n");
    const inp = conn.sent.find((m: any) => m.type === "input");
    expect(inp).toEqual({ type: "input", paneId: "pane-0", data: "ls\n" });
  });

  it("onRemoteInput / onRemoteOutput deliver messages and unsubscribe cleanly", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");

    const inputs: any[] = [];
    const outputs: any[] = [];
    const offIn = r.onRemoteInput((p: string, d: string) => inputs.push([p, d]));
    const offOut = r.onRemoteOutput((from: string, p: string, d: string) => outputs.push([from, p, d]));

    conn.emit("data", { type: "input", paneId: "p1", data: "x" });
    conn.emit("data", { type: "output", paneId: "p1", data: "y" });
    expect(inputs).toEqual([["p1", "x"]]);
    expect(outputs).toEqual([["remote-1", "p1", "y"]]);

    offIn(); offOut();
    conn.emit("data", { type: "input", paneId: "p1", data: "z" });
    expect(inputs).toHaveLength(1);
  });

  it("bye / close removes the peer and resets active if it was selected", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    conn.emit("data", { type: "hello", session: { id: "x", name: "C", device: "mac", paneCount: 1, online: true, isLocal: false } });
    r.selectSession("remote-1");
    expect(r.activeSession()).toBe("remote-1");
    conn.emit("close");
    expect(r.remoteSessions().some((s: any) => s.id === "remote-1")).toBe(false);
    expect(r.activeSession()).toBe(r.localPeerId());
  });

  it("disconnect sends bye, drops all peers, returns to offline", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    await flush();
    r.disconnect();
    expect(conn.sent.some((m: any) => m.type === "bye")).toBe(true);
    expect(r.linkStatus()).toBe("offline");
    expect(r.remoteSessions()).toHaveLength(1);
    expect(r.remoteSessions()[0].isLocal).toBe(true);
  });

  it("panes message updates remotePanes signal and fires onRemotePanes", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    const seen: any[] = [];
    const off = r.onRemotePanes((from: string, list: any[]) => seen.push([from, list]));
    conn.emit("data", { type: "panes", panes: [{ paneId: "p1", label: "zsh" }] });
    expect(r.panesFor("remote-1")).toEqual([{ paneId: "p1", label: "zsh" }]);
    expect(seen).toEqual([["remote-1", [{ paneId: "p1", label: "zsh" }]]]);
    off();
  });

  it("output message is base64-decodable via b64ToBytes", async () => {
    const r = await loadRelay();
    const bytes = r.b64ToBytes(btoa("hello"));
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("close clears remotePanes for that peer", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    conn.emit("data", { type: "panes", panes: [{ paneId: "p1" }] });
    expect(r.panesFor("remote-1")).toHaveLength(1);
    conn.emit("close");
    expect(r.panesFor("remote-1")).toEqual([]);
  });

  it("malformed messages are ignored (no throw)", async () => {
    const r = await loadRelay();
    r.connect();
    await flush();
    const conn = FakePeer.last!.inbound("remote-1");
    conn.emit("open");
    expect(() => {
      conn.emit("data", null);
      conn.emit("data", "garbage");
      conn.emit("data", { type: "unknown-type" });
    }).not.toThrow();
  });
});
