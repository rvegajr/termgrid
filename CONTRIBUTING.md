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

```bash
pnpm exec tsc --noEmit            # frontend typecheck
pnpm test                         # vitest
cargo fmt --all -- --check        # in src-tauri/
cargo clippy --all-targets -- -D warnings
cargo test --lib                  # in src-tauri/
```

Run all of these before opening a PR — CI blocks merge on any failure.

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

PR titles should also follow Conventional Commits — release-please reads merged PR titles.

## Tests

- Frontend: `src/**/*.test.ts(x)` — vitest with jsdom.
- Rust: `src-tauri/src/**/tests.rs` and `#[cfg(test)] mod tests` blocks.
- New surface area gets at least one test. Bug fixes get a regression test that fails before the fix.

## Areas to know

- `src/services/relay.js` — the **only** file handling cross-device PeerJS comms. Keep it one file.
- `src-tauri/src/pty/manager.rs` — PTY spawning. Env vars set here affect every shell.
- `src/services/workspace.ts` — restart-persistence schema. Bump `KEY` if you change the shape.
- `src-tauri/src/history/db.rs` — SQLite schema + FTS5. Migrations are append-only.
