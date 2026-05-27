// Vitest global setup — runs before every test file.
//
// Why this exists: Node 22+ ships an experimental built-in Web Storage
// (`localStorage`). On Node newer than the repo's pinned v22, vitest's
// worker can activate it with `--localstorage-file` but no valid path,
// leaving a partial/broken global `localStorage` (e.g. a `clear()` that
// throws). jsdom's own localStorage — which is complete — gets shadowed.
// That made the `default-shell` tests pass in CI (Node 22) but fail on a
// developer's Node 25 machine.
//
// Installing a deterministic in-memory Storage here sidesteps the whole
// Node-version question and replaces the three hand-rolled per-file mocks
// that previously reassigned `globalThis.localStorage`.

function makeLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

globalThis.localStorage = makeLocalStorageMock();
