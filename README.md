# TermGrid

[![CI](https://github.com/rvegajr/termgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/rvegajr/termgrid/actions/workflows/ci.yml)
[![Release](https://github.com/rvegajr/termgrid/actions/workflows/release.yml/badge.svg)](https://github.com/rvegajr/termgrid/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Auto-tiling cross-platform terminal with **cross-device session linking** via PeerJS. Built on Tauri 2 + SolidJS + xterm.js.

> **Status:** active development. Pre-1.0 — APIs and on-disk formats may change.

## Highlights

- **Auto-tiling** layout engine — 1-up, columns, rows, grid, main-left/right; drag any edge to resize, double-click to snap back.
- **Cross-device link** — PeerJS WebRTC P2P. Open TermGrid on your laptop and your other machine, click the peer's pill in the title bar, **read-only mirror their live terminals**.
- **Per-shell auto-detect** — `$SHELL`, `/etc/shells`, full PATH walk on Unix; pwsh/Windows PowerShell/CMD/Git Bash/WSL on Windows.
- **Workspace persistence** — tabs, panes, layout, font, and 100k-line scrollback survive app restart.
- **Bi-terminal command history** — every command captured to local SQLite (FTS5). Search global or per-pane with **Ctrl+R**.
- **Smart pane labels** — auto-sniffs cwd + branch + shell, top-right of each pane. OSC 7 / OSC 133 escape codes override for 100% accuracy.
- **One JS file for cross-device comms** ([src/services/relay.js](src/services/relay.js)) — easy to audit, easy to swap relay backends.

## Install

> Pre-built downloads land here once the first `v*` tag is published. Until then, build from source.

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `.dmg` from [Releases](https://github.com/rvegajr/termgrid/releases) |
| macOS (Intel) | `.dmg` from [Releases](https://github.com/rvegajr/termgrid/releases) |
| Windows | `.msi` from [Releases](https://github.com/rvegajr/termgrid/releases) |
| Linux | `.AppImage` / `.deb` / `.rpm` from [Releases](https://github.com/rvegajr/termgrid/releases) |

## Build from source

```bash
nvm use                       # Node 22 LTS, per .nvmrc
corepack enable               # provides pnpm
pnpm install --frozen-lockfile
pnpm tauri dev                # dev (hot-reload)
pnpm tauri build              # produce a release bundle for the current OS
```

Rust toolchain via [rustup](https://rustup.rs). Linux also needs:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

## Keyboard shortcuts

| Keys | Action |
|---|---|
| **Ctrl+T** | New tab (with one fresh terminal pane) |
| **Ctrl+N** | Add another pane to current tab (auto-tiles) |
| **Ctrl+W** | Close active pane |
| **Ctrl+R** | Open command history (per-pane / global, FTS search) |
| Click ⚙ | Font, size, cursor, workspace reset |
| Click a session pill | Switch to that device's session (read-only mirror) |
| Drag a pane edge | Resize; release within 2.5% of origin to snap back |
| Double-click pane edge or background | Reset edges to layout |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  SolidJS frontend (src/)                                    │
│  ├─ components/   TitleBar, ResizablePane, HistoryPanel…    │
│  ├─ services/                                               │
│  │   ├─ relay.js          ←  THE ONLY cross-device comms    │
│  │   ├─ pane-snapshot.ts  ←  per-pane scrollback to disk    │
│  │   ├─ pane-meta.ts      ←  cwd/branch/shell sniffer       │
│  │   ├─ history.ts        ←  command recorder (OSC 133)     │
│  │   ├─ workspace.ts      ←  restart persistence            │
│  │   └─ updater.ts        ←  auto-update wrapper            │
│  └─ stores/, types/                                         │
└─────────────────────────────────────────────────────────────┘
                          ▲ ▼ Tauri IPC
┌─────────────────────────────────────────────────────────────┐
│  Rust backend (src-tauri/src/)                              │
│  ├─ pty/         portable-pty spawn + read + resize         │
│  ├─ history/     SQLite + FTS5 (rusqlite, bundled)          │
│  ├─ snapshot.rs  on-disk scrollback (~/Library/.../panes/)  │
│  └─ commands.rs  Tauri command surface                      │
└─────────────────────────────────────────────────────────────┘
```

Detailed product spec: [SPEC.md](SPEC.md).

## File-manager integrations

Right-click any folder in Finder, Explorer, or Nautilus to open it directly in TermGrid. Three modes:
- **Existing pane** — `cd` the focused pane to that path
- **Unused pane** — spawn a fresh pane in the active tab at that path
- **New tab** — open a brand-new tab named after the folder

Setup: see [integrations/](integrations/) — one short script or `.reg` per OS.

## For contributors

See [CONTRIBUTING.md](CONTRIBUTING.md) — local setup, quality gates, commit convention, areas-to-know.

## For maintainers

See [RELEASING.md](RELEASING.md) — the four release rules, per-release runbook, code-signing setup, rollback flow.

The single command you'll run before every push:

```bash
pnpm preflight   # mirrors CI exactly: typecheck + vitest + cargo fmt/clippy/test
```

## License

[MIT](LICENSE)
