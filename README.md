# TermGrid

[![CI](https://github.com/rvegajr/termgrid/actions/workflows/ci.yml/badge.svg)](https://github.com/rvegajr/termgrid/actions/workflows/ci.yml)
[![Release](https://github.com/rvegajr/termgrid/actions/workflows/release.yml/badge.svg)](https://github.com/rvegajr/termgrid/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An auto-tiling, cross-platform terminal with cross-device session mirroring. Built on Tauri 2 + SolidJS + xterm.js.

> **Status:** active development. Pre-1.0 — APIs and on-disk formats may change.

---

## What it does

### Layout

- **Auto-tiling** with seven presets — `auto`, `single`, `columns`, `rows`, `grid`, `main-left`, `main-right` — pick from the title-bar buttons. Layout is saved **per-tab**.
- **One-click multi-pane tabs** from the `+` menu: 4-Pane (2×2), 6-Pane (3×2), 8-Pane (4×2). Spawns a fresh tab pre-tiled.
- **Drag any pane edge** to resize. Release within 2.5% of the original position to snap back to the tile.
- **Double-click** any edge or the tiling background to reset overrides for the active tab.

### Sessions & shells

- **Welcome screen** every launch with platform-aware shell pickers (`$SHELL`, `/etc/shells`, full PATH walk on Unix; pwsh / Windows PowerShell / CMD / Git Bash / WSL distros on Windows). Default shell is highlighted.
- **Restore last session** — prominent button on the welcome screen if a previous workspace exists. Brings back tabs, panes, per-tab layout, edge-drag overrides, and 100k-line scrollback. Shells start fresh; only the visual state is replayed.
- **Pane labels** — top-right of every pane shows a small host pill plus `cwd · branch · shell`. The pill reads as the local hostname (gray) by default and switches to `ssh → user@host` (yellow) when the shell's child process tree contains an active `ssh` / `mosh-client`. Auto-sniffed from prompt; OSC 7 / OSC 133 escape sequences override for perfect accuracy. Yellow dot = sniffed, green dot = OSC.
- **Settings gear** (⚙) — pick from 12 monospace fonts, 10 sizes, cursor blink toggle, "Reset workspace" hard-reset.

### Command history

- **Bi-terminal SQLite history** with FTS5 full-text search. Every command logged with `cmd`, `cwd`, `shell`, `exit_code`, `started_at`, `duration_ms`, `pane_id`, `session_id`.
- **Ctrl+R** opens the search panel — toggle between *This pane* and *Global*. Click any row to inject the command into the active pane (won't auto-execute).
- Heuristic recorder uses prompt sniffing; **OSC 133** semantic-prompt sequences take precedence when emitted.
- DB lives at `~/Library/Application Support/TermGrid/history.sqlite` (macOS) / `%APPDATA%\TermGrid\` (Windows) / `~/.local/share/TermGrid/` (Linux).

### Persistent scrollback

- xterm scrollback bumped to **100,000 lines** per pane.
- Each pane's terminal state is auto-serialized to disk every 5 seconds (debounced) via `@xterm/addon-serialize`.
- On restore, scrollback is replayed before the new shell prints its first prompt — visual continuity above a fresh prompt.
- Files: `~/.../TermGrid/panes/<stableId>.txt`.

### Session adoption (v0.1.3+)

Pull a shell from another terminal app — Terminal.app, iTerm2, gnome-terminal, Windows Terminal, etc. — into a TermGrid pane without losing your CWD, history, environment, or SSH connection.

- **Adoption picker** — palette command **Adopt session…**. Lists every interactive shell on the host (`zsh`, `bash`, `fish`, `pwsh`, `cmd`, `pwsh`, `nu`, `tcsh`, `ksh`, `dash`, `elvish`, `xonsh`), filtered to your processes, tagged with their parent terminal-host app. SSH-spawned shells are flagged so you can choose "reconnect via ssh" instead of `cd` into the local client's cwd.
- **Snap to frontmost** — palette command **Adopt frontmost terminal**. Bring the source terminal to focus, hit the hotkey, and TermGrid picks the most-recently-spawned shell under that app. If multiple candidates exist, the picker opens pre-filtered.
- **Drag-to-pane** — palette command **Start Drag Monitor**. Watches foreground-window transitions: when you switch from a recognized terminal app to TermGrid, the youngest shell under that app is queued for adoption. Works cross-platform via `SetWinEventHook` (Windows), AppleScript polling (macOS), and `xdotool` polling (Linux/X11). Wayland is not supported (no foreign-window introspection).
- **Environment capture** — direct read of the foreign process's full env block via:
  - macOS: `KERN_PROCARGS2` sysctl (no entitlement, no signing required — works on unsigned builds today)
  - Linux: `/proc/<pid>/environ`
  - All hosts: opt-in **shell-cooperative plugin** for high-fidelity capture (see [shell-plugins/README.md](shell-plugins/README.md))
  Captured vars are filtered through a hard-coded allow-list (`PATH`, `LANG`, `VIRTUAL_ENV`, `NVM_DIR`, `CONDA_DEFAULT_ENV`, language toolchain vars). Secrets and `*_TOKEN`/`*_KEY`/`*_SECRET` patterns are never forwarded.
- **SSH-aware reconnect** — for `via_ssh` rows, the picker shows the parsed `user@host:port` and lets you reissue the original `ssh` command (with optional `SendEnv` flags so toolchain vars survive the hop) in the new pane.
- **Adoption memory** — every successful adoption records the CWD; recent CWDs surface on the welcome screen. Palette commands **Export Adoption History…** and **Import Adoption History…** let you back up or sync across machines.
- **Shell plugins** — optional `~/.termgrid/plugins/termgrid.{zsh,bash,fish}` hooks that drop a JSON snapshot per shell PID into `~/.termgrid/shell-state/`. Install via palette command **Install Shell Plugins…**. See [shell-plugins/README.md](shell-plugins/README.md).

### Cross-device session linking

- **PeerJS WebRTC P2P** — the *only* cross-device file is [src/services/relay.js](src/services/relay.js). Easy to audit, easy to swap.
- Click **+ Link devices** in the title bar to register your peer ID with the public broker. Click **+ Add peer** on a second machine and paste the ID.
- The other device shows up as a colored pill in the title bar; click it to mirror that device's terminals **read-only** in your window.
- Demo mode: click **Demo** to seed three mock peers for UI preview without a second machine.
- For corporate firewalls: `RELAY_HOST` / `RELAY_PORT` constants in [relay.js](src/services/relay.js#L34-L36) point at a self-hosted PeerJS server.

### File-manager integrations

Right-click any folder to open it in a TermGrid pane. Three modes:

| Mode | Behavior |
|---|---|
| **Existing pane** | `cd` the focused pane to that path |
| **Unused pane** | Spawn a fresh pane in the active tab at that path |
| **New tab** | Open a brand-new tab named after the folder |

Backed by the `termgrid://` URI scheme. Per-OS install scripts in [integrations/](integrations/):

- **macOS Finder Quick Actions** (`.workflow` bundles built by [integrations/macos/build-quick-actions.sh](integrations/macos/build-quick-actions.sh))
- **Windows Explorer context menu** ([install-explorer-menu.reg](integrations/windows/install-explorer-menu.reg))
- **Linux Nautilus / GNOME Files / Caja actions** ([install.sh](integrations/linux/install.sh))

### UI polish

- **Hover help cards** on every interactive control — title + description + keyboard shortcut where applicable. Quiet `?` badge on hover.
- **Color-aware PTYs** — `TERM=xterm-256color`, `COLORTERM=truecolor`, `CLICOLOR=1`/`CLICOLOR_FORCE=1` set on every spawned shell so `ls`, `git`, etc. colorize by default.
- **Full 16-color ANSI palette** + bright variants in the xterm theme (Catppuccin Mocha).
- **Tooltips on menu controls** (the `+` button, ⚙ gear) use native title attributes — they don't fight the menu they open.

---

## Install

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | `TermGrid_<version>_aarch64.dmg` from [Releases](https://github.com/rvegajr/termgrid/releases) |
| **macOS** (Intel) | `TermGrid_<version>_x64.dmg` |
| **Windows** | `TermGrid_<version>_x64-setup.exe` (NSIS) or `_x64_en-US.msi` |
| **Linux** | `.AppImage` (no install), `.deb` (Debian/Ubuntu), or `.rpm` (Fedora/RHEL) |

> Code signing is not yet configured — macOS Gatekeeper and Windows SmartScreen will warn the first time you open the app. Right-click → Open on macOS, "More info" → "Run anyway" on Windows. We're working on signing.

After installing, optionally install the [file-manager integration](integrations/README.md) for your OS.

## Build from source

```bash
nvm use                       # Node 22 LTS, per .nvmrc
corepack enable               # provides pnpm
pnpm install --frozen-lockfile
pnpm tauri dev                # dev (hot-reload)
pnpm tauri build              # release bundle for the current OS
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
| **Ctrl+F** | Global search across all panes |
| **Ctrl+P** | Command palette (everything below + more) |
| **Ctrl+S** | Save current layout as a session template |
| Click `+` → 4/6/8 grid | Open a multi-pane tab |
| Click ⚙ | Font, size, cursor, workspace reset |
| Click a layout button | Set the active tab's layout (saved per-tab) |
| Click a session pill | Switch to that device's session (read-only mirror) |
| Drag a pane edge | Resize; release within 2.5% to snap back |
| Double-click edge / background | Reset overrides for the active tab |
| Right-click a folder (after install) | Open it in an existing pane / unused pane / new tab |

### Command palette (Ctrl+P)

Most v5 features live here so they don't bloat the title bar. Highlights:

| Command | What it does |
|---|---|
| **Adopt session…** | Open the picker over every adoptable shell on the host |
| **Adopt frontmost terminal** | One-shot adopt the youngest shell under the focused terminal app |
| **Start Drag Monitor / Stop Drag Monitor** | Toggle the foreground-transition watcher for drag-to-pane adoption |
| **Install Shell Plugins…** | Drop zsh/bash/fish hooks into `~/.termgrid/plugins/` |
| **Export Adoption History… / Import Adoption History…** | Back up or sync the per-CWD adoption memory |
| **Save Session as Template…** | Persist the current tab/pane layout for later restore |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS frontend (src/)                                        │
│  ├─ components/   TitleBar, ResizablePane, HistoryPanel,        │
│  │                PaneLabel, RemoteViewer, SettingsMenu,        │
│  │                AdoptionPicker, HelpTip                       │
│  ├─ services/                                                   │
│  │   ├─ relay.js           ←  THE ONLY cross-device comms       │
│  │   ├─ adoption.ts        ←  session-adoption IPC + ssh parse  │
│  │   ├─ pane-host.ts       ←  local / ssh host indicator        │
│  │   ├─ deep-link.ts       ←  termgrid:// URL handler           │
│  │   ├─ pane-snapshot.ts   ←  per-pane scrollback (disk)        │
│  │   ├─ pane-meta.ts       ←  cwd / branch / shell sniffer      │
│  │   ├─ history.ts         ←  command recorder (OSC 133)        │
│  │   ├─ workspace.ts       ←  restart persistence (v2 schema)   │
│  │   ├─ terminal-prefs.ts  ←  font / size / cursor              │
│  │   └─ tauri-ipc.ts       ←  Rust command surface              │
│  └─ stores/, types/                                             │
└─────────────────────────────────────────────────────────────────┘
                          ▲ ▼ Tauri IPC + tauri-plugin-deep-link
┌─────────────────────────────────────────────────────────────────┐
│  Rust backend (src-tauri/src/)                                  │
│  ├─ adoption/                                                   │
│  │   ├─ discover.rs         shell enumeration + ancestry tag    │
│  │   ├─ drag_{macos,linux,windows}.rs                           │
│  │   ├─ env_capture.rs      ps -E / /proc env probes            │
│  │   ├─ env_macos_native.rs KERN_PROCARGS2 sysctl reader        │
│  │   ├─ shell_plugin.rs     ~/.termgrid/shell-state/ reader     │
│  │   ├─ ssh_parse.rs        argv → user@host:port               │
│  │   └─ frontmost.rs        per-OS frontmost-app probe          │
│  ├─ pty/             portable-pty spawn + read + resize         │
│  ├─ history/         SQLite + FTS5 (rusqlite, bundled)          │
│  ├─ snapshot.rs      on-disk scrollback files                   │
│  ├─ commands.rs      Tauri command surface (incl. pane_remote_context) │
│  └─ pty/shell_detect.rs                                         │
│       Linux/macOS: $SHELL → /etc/shells → PATH walk → backstops │
│       Windows: pwsh → Windows PS → CMD → Git Bash → WSL distros │
└─────────────────────────────────────────────────────────────────┘
```

Full product spec: [SPEC.md](SPEC.md).

## File-manager integrations (deep-link)

Right-click any folder in Finder, Explorer, or Nautilus to open it directly in TermGrid. The OS routes the click to a `termgrid://open?path=…&mode=…` URL, which Tauri delivers to the running app (or launches it if needed).

Setup: per-OS scripts in [integrations/](integrations/).

## For contributors

See [CONTRIBUTING.md](CONTRIBUTING.md) — local setup, quality gates, commit convention, areas-to-know.

The single command you'll run before every push:

```bash
pnpm preflight   # mirrors CI exactly: typecheck + vitest + cargo fmt/clippy/test
```

## For maintainers

See [RELEASING.md](RELEASING.md) — the four release rules, per-release runbook, code-signing setup, rollback flow.

## Tests

- **92 frontend tests** ([src/__tests__/](src/__tests__/)) — vitest + jsdom; covers layout engine, relay protocol, stores, adoption import/export.
- **97 Rust tests** ([src-tauri/src/](src-tauri/src/)) — `cargo test --lib`; covers PTY lifecycle, history DB (in-memory SQLite), adoption discovery + env parsing, `KERN_PROCARGS2` reader, ssh argv parser.
- **3-platform CI matrix** on every PR — macOS, Linux, Windows debug builds + lint/test/fmt/clippy gates.

## License

[MIT](LICENSE)
