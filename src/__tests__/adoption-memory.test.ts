import { afterEach, beforeEach, describe, expect, it } from "vitest";

// jsdom's localStorage isn't always available in this project's setup;
// provide a Map-backed shim matching the existing test pattern in
// `machine-cache.test.ts`.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

(globalThis as { localStorage: Storage }).localStorage =
  localStorageMock as Storage;

import * as memory from "../services/adoption-memory";

/**
 * Tests for the v4 persisted adoption memory module.
 *
 * Storage backend is `localStorage`, which is provided by the test
 * environment (jsdom / happy-dom). We wipe it before each test so the
 * suite is independent of run order.
 */

const ENTRY = (overrides: Partial<memory.AdoptionMemoryEntry> = {}) => ({
  adoptedAt: 1000,
  shell: "zsh",
  cwd: "/Users/me/proj",
  parent: "Terminal",
  envNames: ["VIRTUAL_ENV"],
  mode: "new-tab" as const,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("recordAdoption + listAdoptions", () => {
  it("returns the entry just written", () => {
    memory.recordAdoption(ENTRY());
    const list = memory.listAdoptions();
    expect(list).toHaveLength(1);
    expect(list[0].cwd).toBe("/Users/me/proj");
  });

  it("returns most-recent-first", () => {
    memory.recordAdoption(ENTRY({ adoptedAt: 1000, cwd: "/a" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2000, cwd: "/b" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 3000, cwd: "/c" }));
    expect(memory.listAdoptions().map((e) => e.cwd)).toEqual([
      "/c",
      "/b",
      "/a",
    ]);
  });

  it("de-dupes by (cwd, shell) within the recent window", () => {
    memory.recordAdoption(ENTRY({ adoptedAt: 1000, cwd: "/p", shell: "zsh" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2000, cwd: "/p", shell: "zsh" }));
    // Only the latest survives.
    const list = memory.listAdoptions();
    expect(list).toHaveLength(1);
    expect(list[0].adoptedAt).toBe(2000);
  });

  it("does NOT de-dupe across different shells in the same cwd", () => {
    memory.recordAdoption(ENTRY({ adoptedAt: 1000, cwd: "/p", shell: "zsh" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2000, cwd: "/p", shell: "bash" }));
    expect(memory.listAdoptions()).toHaveLength(2);
  });

  it("caps storage at the bounded MAX_ENTRIES", () => {
    for (let i = 0; i < 80; i++) {
      memory.recordAdoption(ENTRY({ adoptedAt: i, cwd: `/p${i}` }));
    }
    const list = memory.listAdoptions();
    // We don't export MAX_ENTRIES but it's 50; the bound is a contract.
    expect(list.length).toBeLessThanOrEqual(50);
    // Oldest are evicted; the latest must still be present.
    expect(list[0].cwd).toBe("/p79");
  });
});

describe("recentAdoptedCwds", () => {
  it("returns distinct cwds in most-recent-first order, capped", () => {
    memory.recordAdoption(ENTRY({ adoptedAt: 1, cwd: "/a" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2, cwd: "/b" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 3, cwd: "/a", shell: "bash" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 4, cwd: "/c" }));
    expect(memory.recentAdoptedCwds(5)).toEqual(["/c", "/a", "/b"]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      memory.recordAdoption(ENTRY({ adoptedAt: i, cwd: `/p${i}` }));
    }
    expect(memory.recentAdoptedCwds(3)).toHaveLength(3);
  });

  it("ignores entries with null cwd", () => {
    memory.recordAdoption(ENTRY({ adoptedAt: 1, cwd: null }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2, cwd: "/real" }));
    expect(memory.recentAdoptedCwds(5)).toEqual(["/real"]);
  });
});

describe("dominantParent", () => {
  it("returns the most-frequent parent name", () => {
    memory.recordAdoption(ENTRY({ parent: "Terminal", cwd: "/a" }));
    memory.recordAdoption(ENTRY({ parent: "Terminal", cwd: "/b" }));
    memory.recordAdoption(ENTRY({ parent: "Cursor Helper", cwd: "/c" }));
    expect(memory.dominantParent()).toBe("Terminal");
  });

  it("returns null on empty history", () => {
    expect(memory.dominantParent()).toBeNull();
  });

  it("skips entries with null parent", () => {
    memory.recordAdoption(ENTRY({ parent: null, cwd: "/a" }));
    memory.recordAdoption(ENTRY({ parent: "iTerm2", cwd: "/b" }));
    expect(memory.dominantParent()).toBe("iTerm2");
  });
});

describe("clearAdoptionMemory", () => {
  it("wipes all entries", () => {
    memory.recordAdoption(ENTRY());
    expect(memory.listAdoptions()).toHaveLength(1);
    memory.clearAdoptionMemory();
    expect(memory.listAdoptions()).toHaveLength(0);
  });
});

describe("corruption safety", () => {
  it("treats garbage in localStorage as empty", () => {
    localStorage.setItem("termgrid.adoption.memory.v1", "{not json");
    expect(memory.listAdoptions()).toEqual([]);
  });

  it("treats wrong version as empty", () => {
    localStorage.setItem(
      "termgrid.adoption.memory.v1",
      JSON.stringify({ version: 99, entries: [{ adoptedAt: 1 }] }),
    );
    expect(memory.listAdoptions()).toEqual([]);
  });
});

describe("v5: export and import logic", () => {
  it("export shape is valid JSON and can be parsed back", () => {
    memory.clearAdoptionMemory();
    memory.recordAdoption(ENTRY({ adoptedAt: 1000, shell: "zsh", cwd: "/tmp/a", parent: "Terminal.app" }));
    memory.recordAdoption(ENTRY({ adoptedAt: 2000, shell: "bash", cwd: "/tmp/b", parent: "iTerm2" }));

    // Manually construct the shape we'd export
    const list = memory.listAdoptions();
    const shape = { version: 1, entries: list };
    const json = JSON.stringify(shape);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.entries.length).toBe(2);
    // listAdoptions() returns desc by adoptedAt, so newest (bash) first
    expect(parsed.entries[0].shell).toBe("bash");
    expect(parsed.entries[1].shell).toBe("zsh");
  });
});
