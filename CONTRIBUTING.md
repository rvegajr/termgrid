# Contributing to TermGrid

## Local setup

```bash
nvm use                      # picks Node from .nvmrc
corepack enable              # gets pnpm
pnpm install --frozen-lockfile
pnpm tauri dev               # opens the app
```

Rust toolchain via [rustup](https://rustup.rs). On Linux you also need:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

## Quality gates (matches CI exactly)

One command runs everything CI runs:

```bash
pnpm preflight
```

That expands to:

```bash
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest
pnpm fmt:rust:check  # cargo fmt --check
pnpm lint:rust       # cargo clippy -- -D warnings
pnpm test:rust       # cargo test --lib
```

Run `pnpm preflight` before opening a PR — CI blocks merge on any failure.

Auto-fix Rust formatting:

```bash
pnpm fmt:rust
```

## Commits & PRs

We use **Conventional Commits** because release-please reads them to bump the version and write the changelog.

| Prefix | When | Bumps |
|---|---|---|
| `feat:` | new user-visible capability | minor |
| `fix:` | bug fix | patch |
| `perf:` | perf improvement | patch |
| `refactor:` | internal restructure, no behavior change | patch |
| `docs:` | docs-only | none |
| `test:` | test-only | none |
| `chore:` / `build:` / `ci:` | tooling / infra | none |
| `feat!:` or any with `BREAKING CHANGE:` footer | breaking change | major |

Examples:

```
feat: add OSC 7 cwd detection in pane labels
fix(relay): drop stale remote panes on peer close
refactor!: rename pane.id to pane.runtimeId

BREAKING CHANGE: PaneState.id renamed; consumers must use stableId.
```

PR titles should also follow Conventional Commits — release-please reads merged PR titles. See [RELEASING.md](RELEASING.md#the-four-release-rules) for the full release rules.

## Tests

- Frontend: `src/**/*.test.ts(x)` — vitest with jsdom.
- Rust: `src-tauri/src/**/tests.rs` and `#[cfg(test)] mod tests` blocks.
- New surface area gets at least one test. Bug fixes get a regression test that fails before the fix.

## Areas to know

- `src/services/relay.js` — the **only** file handling cross-device PeerJS comms. Keep it one file.
- `src-tauri/src/pty/manager.rs` — PTY spawning. Env vars set here affect every shell.
- `src/services/workspace.ts` — restart-persistence schema. Bump `KEY` if you change the shape.
- `src-tauri/src/history/db.rs` — SQLite schema + FTS5. Migrations are append-only.
