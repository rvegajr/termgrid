import { describe, it, expect } from "vitest";
import { decodePtyChunk } from "../services/pane-meta";
import { b64ToBytes } from "../services/relay";

describe("pane-perf", () => {
  describe("decodePtyChunk", () => {
    it("decodes ASCII text", () => {
      const bytes = new TextEncoder().encode("hello world");
      const text = decodePtyChunk(bytes);
      expect(text).toBe("hello world");
    });

    it("decodes UTF-8 with multibyte characters", () => {
      const bytes = new TextEncoder().encode("hello 🦀 世界");
      const text = decodePtyChunk(bytes);
      expect(text).toBe("hello 🦀 世界");
    });

    it("decodes ANSI escape sequences", () => {
      const bytes = new TextEncoder().encode("\x1b[31mred\x1b[0m");
      const text = decodePtyChunk(bytes);
      expect(text).toBe("\x1b[31mred\x1b[0m");
    });

    it("handles empty bytes", () => {
      const bytes = new Uint8Array(0);
      const text = decodePtyChunk(bytes);
      expect(text).toBe("");
    });
  });

  describe("base64 round-trip (b64ToBytes)", () => {
    it("round-trips ASCII text", () => {
      const original = new TextEncoder().encode("hello world");
      const b64 = btoa(String.fromCharCode(...original));
      const decoded = b64ToBytes(b64);
      // Compare as arrays for reliable vitest comparison
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("round-trips binary data", () => {
      const original = new Uint8Array([0, 1, 2, 255, 254, 253]);
      const b64 = btoa(String.fromCharCode(...original));
      const decoded = b64ToBytes(b64);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("round-trips ANSI escape sequences", () => {
      const original = new TextEncoder().encode("\x1b[31mred\x1b[0m");
      const b64 = btoa(String.fromCharCode(...original));
      const decoded = b64ToBytes(b64);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it("handles empty base64", () => {
      const decoded = b64ToBytes("");
      expect(decoded.length).toBe(0);
    });
  });

  describe("paneIndex memoization", () => {
    it("maps backendId to pane", () => {
      // This test simulates the paneIndex Map usage pattern
      const panes = [
        { id: "pane-0", backendId: "backend-0" },
        { id: "pane-1", backendId: "backend-1" },
        { id: "pane-2", backendId: "backend-2" },
      ];

      // Build index (simulating createMemo logic)
      const index = new Map();
      for (const p of panes) index.set(p.backendId, p);

      // Verify O(1) lookup
      const pane = index.get("backend-1");
      expect(pane).toBeDefined();
      expect(pane?.id).toBe("pane-1");
      expect(pane?.backendId).toBe("backend-1");
    });

    it("handles missing backendId gracefully", () => {
      const panes = [{ id: "pane-0", backendId: "backend-0" }];
      const index = new Map();
      for (const p of panes) index.set(p.backendId, p);

      const pane = index.get("nonexistent");
      expect(pane).toBeUndefined();
    });
  });
});
