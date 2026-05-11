import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage for Node environment
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] || null,
  };
})();

globalThis.localStorage = localStorageMock as Storage;

// Mock crypto.subtle for fingerprint computation
const mockDigest = vi.fn(async (_algorithm: string, _data: BufferSource) => {
  // Return a fixed hash for testing
  const bytes = new Uint8Array(20);
  bytes.fill(42); // Fixed value for consistent fingerprint
  return bytes.buffer;
});

vi.stubGlobal('crypto', {
  subtle: {
    digest: mockDigest,
  },
});

// Mock screen
vi.stubGlobal('screen', { colorDepth: 24 });

// Fresh import per test to reset module state
async function loadCache() {
  vi.resetModules();
  localStorage.clear();
  return await import("../services/machine-cache.ts");
}

const flush = () => new Promise(r => setTimeout(r, 300)); // Wait for debounce (250ms + buffer)

describe("machine-cache", () => {
  beforeEach(() => {
    localStorage.clear();
    mockDigest.mockClear();
  });

  it("round-trip: set and get a value", async () => {
    const cache = await loadCache();
    await cache.set("test-key", { foo: "bar" });
    await flush();

    const value = await cache.get<{ foo: string }>("test-key");
    expect(value).toEqual({ foo: "bar" });
  });

  it("returns undefined for missing keys", async () => {
    const cache = await loadCache();
    const value = await cache.get("nonexistent");
    expect(value).toBeUndefined();
  });

  it("returns undefined on fingerprint mismatch", async () => {
    const cache = await loadCache();
    await cache.set("test-key", { data: 123 });
    await flush();

    // Verify it was written
    expect(await cache.get("test-key")).toEqual({ data: 123 });

    // Simulate a different machine by changing the fingerprint
    const key = "tg.cache.v1.test-key";
    const raw = localStorage.getItem(key);
    expect(raw).toBeTruthy();

    if (raw) {
      const entry = JSON.parse(raw);
      entry.fingerprint = "different-machine-hash";
      localStorage.setItem(key, JSON.stringify(entry));
    }

    // Should return undefined and clean up
    const value = await cache.get("test-key");
    expect(value).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("returns undefined and cleans up corrupt data", async () => {
    const cache = await loadCache();
    const key = "tg.cache.v1.test-key";
    localStorage.setItem(key, "not-valid-json{{{");

    const value = await cache.get("test-key");
    expect(value).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("remove() deletes a key", async () => {
    const cache = await loadCache();
    await cache.set("test-key", "value");
    await flush();

    expect(await cache.get("test-key")).toBe("value");

    cache.remove("test-key");
    expect(await cache.get("test-key")).toBeUndefined();
  });

  it("debounces multiple writes within 250ms", async () => {
    const cache = await loadCache();
    const setItemSpy = vi.spyOn(localStorage, "setItem");

    await cache.set("counter", 1);
    await cache.set("counter", 2);
    await cache.set("counter", 3);
    await cache.set("counter", 4);

    // Should not have written yet (debounced)
    expect(setItemSpy).not.toHaveBeenCalled();

    await flush();

    // Should have written once with the final value
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(await cache.get("counter")).toBe(4);

    setItemSpy.mockRestore();
  });

  it("subscribe() calls fn immediately and on updates", async () => {
    const cache = await loadCache();
    const calls: any[] = [];

    await cache.set("watched", "initial");
    await flush();

    const unsub = cache.subscribe("watched", (value) => {
      calls.push(value);
    });

    // Wait for initial call
    await new Promise(r => setTimeout(r, 10));
    expect(calls).toEqual(["initial"]);

    // Update
    await cache.set("watched", "updated");
    await flush();
    await new Promise(r => setTimeout(r, 10));

    expect(calls).toEqual(["initial", "updated"]);

    unsub();
  });

  it("subscribe() returns undefined for missing keys", async () => {
    const cache = await loadCache();
    const calls: any[] = [];

    const unsub = cache.subscribe("missing", (value) => {
      calls.push(value);
    });

    await new Promise(r => setTimeout(r, 10));
    expect(calls).toEqual([undefined]);

    unsub();
  });

  it("handles multiple simultaneous keys", async () => {
    const cache = await loadCache();

    await cache.set("key1", "value1");
    await cache.set("key2", { nested: "value2" });
    await cache.set("key3", [1, 2, 3]);
    await flush();

    expect(await cache.get("key1")).toBe("value1");
    expect(await cache.get("key2")).toEqual({ nested: "value2" });
    expect(await cache.get("key3")).toEqual([1, 2, 3]);
  });

  it("uses correct key prefix format", async () => {
    const cache = await loadCache();
    localStorage.clear(); // Ensure clean state
    await cache.set("mykey", "myvalue");
    await flush();

    const storedKey = "tg.cache.v1.mykey";
    expect(localStorage.getItem(storedKey)).toBeTruthy();
    
    const parsed = JSON.parse(localStorage.getItem(storedKey)!);
    expect(parsed.value).toBe("myvalue");
    expect(parsed.fingerprint).toBeTruthy();
    expect(parsed.savedAt).toBeTypeOf("number");
  });
});
