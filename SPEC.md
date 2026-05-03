# TermGrid — Full Product Specification

## 1. Product Vision

The best terminal application ever built. A cross-platform, native desktop terminal that **automatically tiles** sessions, supports **tabs and pane merging/breaking**, has **unified command history**, **AI integration**, **command interception**, **inter-terminal communication**, and **reverse-proxy relay for shared sessions through corporate firewalls** — all with native copy/paste and desktop app behavior.

---

## 2. Core Requirements

### 2.1 Shell Support (Native, No WSL)
- PowerShell (Windows)
- CMD (Windows)
- bash
- zsh
- Git Bash (Windows)
- fish, nushell, or any shell the user has installed
- Per-pane shell selection (mix shells in one workspace)

### 2.2 Auto-Tiling Layout Engine
- **New pane**: automatically placed in optimal screen position
- **Equal distribution**: all visible panes get roughly equal space
- **Smart splitting**: 1=full, 2=side-by-side, 3=one left + two stacked right, 4=grid, etc.
- **Resize**: drag borders to manually adjust; double-click border to re-equalize
- **Zoom**: temporarily maximize one pane (toggle), others remain in background
- **Layout presets**: user can save/load named layouts (e.g., "3-up dev", "monitoring wall")

### 2.3 Tabs & Pane Management
- Group panes into tabs
- Drag a pane into another tab (merge)
- Break a pane out of a tab into its own tab or floating window
- Reorder tabs via drag-and-drop
- Tab bar with close buttons, rename, color-coding
- Right-click context menu on panes and tabs

### 2.4 Native App Behavior (NON-NEGOTIABLE)
- **Ctrl+C**: copy selected text (send SIGINT only when no selection)
- **Ctrl+V**: paste from clipboard
- **Ctrl+Shift+C / Ctrl+Shift+V**: always copy/paste (fallback)
- **Ctrl+A**: select all text in pane
- **Ctrl+F**: search/find in terminal output
- **Ctrl+T**: new tab
- **Ctrl+N**: new pane
- **Ctrl+W**: close pane
- Standard window chrome (minimize, maximize, close, resize)
- System tray / taskbar presence
- Remembers window size, position, and layout on restart
- Proper font rendering with ligature support
- Right-click context menu (copy, paste, select all, split, etc.)

---

## 3. Advanced Features

### 3.1 Unified Command History

A central history engine that captures every command entered across all terminals.

- **Global history**: searchable across all panes, all sessions, all time
- **Per-terminal history**: each pane also has its own isolated history
- **Scoped history**: filter by shell type, working directory, project, date range
- **History sync**: optionally sync history to a local SQLite database
- **Smart recall**: Ctrl+R searches global history with fuzzy matching
- **History annotations**: mark commands as favorites, add notes
- **Privacy controls**: exclude patterns (e.g., commands containing passwords, tokens)
- **Cross-session persistence**: history survives app restarts, pane closes, reboots

#### How it works
The app intercepts command submission at the PTY layer (reads input before newline) and captures:
- The command string
- Timestamp
- Shell type (bash, PowerShell, zsh, etc.)
- Working directory
- Pane/tab ID
- Exit code (captured after execution)
- Execution duration

Stored in a local SQLite database. Indexed for fast fuzzy search.

### 3.2 Command Interception & Hooks

The terminal can intercept, modify, or block commands before they execute.

- **Pre-execution hooks**: run logic before a command executes
  - Confirm dangerous commands (`rm -rf`, `DROP TABLE`, `git push --force`)
  - Auto-expand aliases or macros
  - Inject environment variables
  - Log to audit trail
- **Post-execution hooks**: run logic after a command completes
  - Capture exit code
  - Trigger notifications on long-running command completion
  - Auto-retry failed commands (configurable)
- **Command transforms**: rewrite commands before execution
  - E.g., auto-add `--dry-run` to destructive commands in certain contexts
- **Blocking rules**: prevent specific commands from running (parental controls, org policy)
- **Hook configuration**: YAML/JSON config file, per-project overrides

### 3.3 Inter-Terminal Communication

Panes can talk to each other programmatically.

- **Pipe output**: send stdout of one pane to stdin of another (like Unix pipes, but across panes)
- **Broadcast input**: type once, send to multiple panes simultaneously (cluster admin mode)
- **Shared variables**: set a variable in one pane, read it in another
- **Event bus**: panes can emit named events that other panes subscribe to
  - E.g., pane 1 finishes `npm build` → pane 2 auto-runs `npm test`
- **Command palette actions**: "Send output to pane 2", "Broadcast mode on/off"
- **Visual indicators**: show which panes are linked/piped/broadcasting

### 3.4 AI Integration

First-class AI assistance built into the terminal.

- **AI command bar**: Ctrl+K opens natural language input
  - "Find all files modified in the last hour" → generates and optionally runs the command
  - "What does this error mean?" → explains the last error in context
  - "Convert this PowerShell to bash" → rewrites for the current shell
- **Inline suggestions**: ghost text completion for commands (like GitHub Copilot for the terminal)
- **Error explanation**: when a command fails, offer AI explanation with fix suggestions
- **Context-aware**: AI sees the terminal's recent output, working directory, shell type, and command history
- **Multi-model support**: configurable backend (Claude API, OpenAI, Ollama for local, etc.)
- **Privacy controls**: 
  - Option to run fully local (Ollama)
  - Redaction rules for sensitive output before sending to cloud AI
  - Per-workspace AI enable/disable
- **AI pane**: dedicated pane that acts as a chat interface with full terminal context
- **Agent mode**: AI can execute multi-step workflows across panes with user approval

### 3.5 Relay / Shared Sessions (Reverse Proxy)

Enable terminal sharing through corporate firewalls without exposing internal networks.

#### Architecture
```
Corporate Network                    Relay Server (Cloud)                User's Machine
+------------------+                +------------------+                +------------------+
|                  |                |                  |                |                  |
|  TermGrid        | --- outbound  |  TermGrid Relay  | <-- outbound  |  TermGrid        |
|  (behind FW)     | --> WebSocket |  (public/cloud)  | --- WebSocket |  (home/remote)   |
|                  |                |                  |                |                  |
|  Initiates       |                |  Brokers the     |                |  Connects to     |
|  connection OUT  |                |  connection      |                |  relay server    |
+------------------+                +------------------+                +------------------+
     ^                                                                        |
     |                    Encrypted tunnel (WSS/TLS)                          |
     +------------------------------------------------------------------------+
```

- **No inbound ports required**: corporate terminal connects OUTBOUND to relay
- **Relay server**: lightweight broker (can be self-hosted or cloud-hosted)
- **Session sharing modes**:
  - **View-only**: remote user can see but not type
  - **Interactive**: remote user can type (with host approval)
  - **Collaborative**: both users see the same terminal, cursor indicators for each user
- **Authentication**: 
  - Session tokens (short-lived, revocable)
  - Optional SSO/OIDC integration
  - Invite links with expiry
- **Encryption**: end-to-end encrypted (relay server cannot read terminal content)
- **Access controls**:
  - Host can revoke access instantly
  - Time-limited sessions
  - Command whitelist/blacklist for remote users
  - Audit log of all remote actions
- **Use cases**:
  - Pair programming through corporate VPN
  - Remote support / debugging
  - Teaching / mentoring
  - Sharing a running process output with a colleague

#### Relay Protocol
- WebSocket-based (traverses proxies and firewalls)
- Multiplexed channels (share specific panes, not all)
- Terminal state sync (new viewer gets current screen state, not blank)
- Latency-tolerant (buffered updates, catch-up on reconnect)

---

## 4. Cross-Platform

- Windows 10/11 (native, no WSL)
- macOS (12+)
- Linux (X11 and Wayland)

---

## 5. Performance Requirements

- Startup: < 1 second to first interactive shell
- Memory: < 50MB base + < 10MB per terminal pane
- Rendering: 60fps scrolling, smooth resize
- History search: < 100ms for 100k+ commands
- Relay latency: < 50ms overhead on top of network RTT

---

## 6. Configuration

- Keybinding customization (JSON/YAML, importable)
- Color schemes / themes (bundled + custom, import from iTerm2/Windows Terminal)
- Font selection with preview
- Default shell per platform
- Startup layout presets
- Per-project settings (`.termgrid.json` in project root)
- Settings UI (not just config files)

---

## 7. Technology Evaluation

### 7.1 Terminal Emulation Libraries

| Library | Language | License | Windows ConPTY | Cross-Platform | Maturity |
|---------|----------|---------|----------------|----------------|----------|
| **xterm.js** | TypeScript | MIT | Via node-pty | Yes (web) | Very High (VS Code, Tabby) |
| **portable-pty** | Rust | MIT | Yes | Yes | High (powers WezTerm) |
| **alacritty_terminal** | Rust | Apache 2.0 | Yes | Yes | High (powers Alacritty) |
| **termwiz** | Rust | MIT | Yes | Yes | High (WezTerm ecosystem) |
| **node-pty** | C++/JS | MIT | Yes (ConPTY) | Yes | Very High (Microsoft) |

### 7.2 Application Framework Evaluation

#### A. Tauri 2.0 + xterm.js + portable-pty
- **Stack**: Rust backend + Web frontend + xterm.js
- **Bundle**: ~10MB
- **Tiling UI**: Easy (CSS grid)
- **AI integration**: Easy (HTTP calls from Rust or JS)
- **Relay**: Easy (Rust WebSocket server/client, tokio)
- **History DB**: Easy (rusqlite or sqlx in backend)
- **Command interception**: Medium (intercept at PTY read/write layer in Rust)
- **Inter-terminal comm**: Easy (Rust backend brokers messages between panes)
- **Pros**: Small, fast, web UI makes tiling/tabs trivial, Rust for performance-critical parts
- **Cons**: WebView rendering (not GPU terminal), webview quirks across platforms
- **Time to MVP**: 4-6 months
- **Time to full spec**: 10-14 months

#### B. Fork WezTerm
- **Stack**: Pure Rust (19+ crates), GPU rendering
- **Bundle**: ~15MB
- **Tiling UI**: Medium (modify mux crate)
- **AI integration**: Medium (add HTTP client, UI overlay)
- **Relay**: Medium (already has mux-server architecture — extend it)
- **History DB**: Medium (add SQLite layer)
- **Command interception**: Hard (deep in PTY pipeline)
- **Inter-terminal comm**: Medium (mux crate already manages panes)
- **Pros**: Complete terminal emulator. GPU rendering. Multiplexer built in. MIT. Already has client-server mux architecture perfect for relay feature.
- **Cons**: Large Rust codebase. Complex rendering. Adding web-like UI overlays (AI bar, settings) is hard in a GPU-rendered app.
- **Time to MVP**: 6-10 months
- **Time to full spec**: 14-20 months

#### C. Electron + xterm.js + node-pty
- **Stack**: Node.js + Chromium + xterm.js
- **Bundle**: ~150MB+
- **Everything else**: Same as Tauri but heavier
- **Pros**: Fastest development. Largest ecosystem. Most proven.
- **Cons**: 150MB bundle. 300MB+ RAM. Not "the best terminal" if it's bloated.
- **Time to MVP**: 3-5 months
- **Time to full spec**: 8-12 months

#### D. Avalonia (.NET)
- **Stack**: C# / .NET 8+ / Avalonia 11
- **Bundle**: ~25MB
- **Pros**: True native feel. Strong Windows story. C# is productive.
- **Cons**: Terminal emulation control is immature. Most work of any option.
- **Time to MVP**: 8-14 months
- **Time to full spec**: 16-24 months

### 7.3 Evaluation Against Full Requirements

| Requirement | Tauri+xterm.js | Fork WezTerm | Electron+xterm.js | Avalonia .NET |
|-------------|:-:|:-:|:-:|:-:|
| Windows native | Yes | Yes | Yes | Yes |
| macOS + Linux | Yes | Yes | Yes | Yes |
| Auto-tiling | Easy | Medium | Easy | Hard |
| Tabs + merge/break | Easy | Medium | Easy | Medium |
| Native Ctrl+C/V | Yes | Yes | Yes | Yes |
| Unified history | Easy | Medium | Easy | Medium |
| Command interception | Medium | Hard | Medium | Medium |
| Inter-terminal comm | Easy | Medium | Easy | Medium |
| AI integration | Easy | Hard | Easy | Medium |
| Relay/shared sessions | Easy | Medium* | Easy | Medium |
| GPU rendering | No | Yes | No | No |
| Small footprint | Yes (~10MB) | Yes (~15MB) | No (~150MB) | Yes (~25MB) |
| Dev speed | Fast | Slow | Fastest | Slowest |
| Settings UI | Easy (web) | Hard | Easy (web) | Medium |

*WezTerm already has a client-server mux architecture that could be extended for relay

### 7.4 Hybrid Approach: Tauri + WezTerm Crates

Use the best of both worlds:
- **Frontend**: Tauri 2.0 + xterm.js (tiling, tabs, AI bar, settings UI)
- **Backend PTY**: `portable-pty` crate from WezTerm (cross-platform PTY)
- **Terminal parsing**: `termwiz` crate from WezTerm (VTE parsing, escape sequences)
- **Relay**: Custom Rust WebSocket relay (tokio + tokio-tungstenite)
- **History**: rusqlite for local SQLite database
- **AI**: reqwest for API calls, with streaming response rendering

This gives you web UI flexibility for the complex interface (tiling, tabs, drag-drop, AI chat, settings) while using battle-tested Rust crates for the terminal backend.

---

## 8. Architecture (Tauri + WezTerm Crates — Recommended)

```
+============================================================================+
|  TERMGRID APPLICATION                                                      |
|                                                                            |
|  +-- Native Window (Tauri 2.0 / OS WebView) ----------------------------+ |
|  |                                                                       | |
|  |  +-- AI Command Bar (Ctrl+K) ------------------------------------+   | |
|  |  | "find files modified today" → [Run: find . -mtime -1]  [Edit] |   | |
|  |  +---------------------------------------------------------------+   | |
|  |                                                                       | |
|  |  +-- Tab Bar (drag-drop, merge, break-out, color-code) ----------+   | |
|  |  | [Tab 1: Dev] | [Tab 2: Servers] | [Tab 3: Logs] | [+]        |   | |
|  |  +---------------------------------------------------------------+   | |
|  |                                                                       | |
|  |  +-- Tiling Container (CSS Grid, auto-layout) -------------------+   | |
|  |  |  +---------------------+  +---------------------+             |   | |
|  |  |  | xterm.js (pane 1)   |  | xterm.js (pane 2)   |            |   | |
|  |  |  | [PowerShell]        |  | [bash]               |            |   | |
|  |  |  | cwd: C:\project     |  | cwd: ~/project       |            |   | |
|  |  |  +---------------------+  +---------------------+             |   | |
|  |  |  +---------------------+  +---------------------+             |   | |
|  |  |  | xterm.js (pane 3)   |  | xterm.js (pane 4)   |            |   | |
|  |  |  | [zsh]               |  | [AI Chat]            |            |   | |
|  |  |  +---------------------+  +---------------------+             |   | |
|  |  +---------------------------------------------------------------+   | |
|  |                                                                       | |
|  |  +-- Status Bar -------------+-------------------+----------------+   | |
|  |  | 4 panes | broadcast: OFF  | relay: connected  | history: 12k  |   | |
|  |  +---------------------------------------------------------------+   | |
|  +-------------------------------------------------------------------+   |
|                              |                                            |
|                    Tauri IPC (invoke/events)                               |
|                              |                                            |
|  +-- Rust Backend (Tauri Core) -----------------------------------------+ |
|  |                                                                       | |
|  |  +-- PTY Manager -------+  +-- History Engine ----+                  | |
|  |  | portable-pty          |  | SQLite (rusqlite)    |                  | |
|  |  | Per-pane PTY process  |  | Command indexing     |                  | |
|  |  | Input interception    |  | Fuzzy search         |                  | |
|  |  | Output capture        |  | Privacy filters      |                  | |
|  |  +-----------------------+  +----------------------+                  | |
|  |                                                                       | |
|  |  +-- Hook Engine --------+  +-- Inter-Pane Bus ----+                  | |
|  |  | Pre/post exec hooks   |  | Event pub/sub        |                  | |
|  |  | Command transforms    |  | Pipe routing         |                  | |
|  |  | Blocking rules        |  | Broadcast relay      |                  | |
|  |  | Audit logging         |  | Shared variables     |                  | |
|  |  +-----------------------+  +----------------------+                  | |
|  |                                                                       | |
|  |  +-- AI Engine -----------+  +-- Relay Client -----+                  | |
|  |  | Multi-provider         |  | WSS outbound conn   |                  | |
|  |  | (Claude/OpenAI/Ollama) |  | E2E encryption      |                  | |
|  |  | Context assembly       |  | Pane multiplexing   |                  | |
|  |  | Streaming responses    |  | Auth/session mgmt   |                  | |
|  |  +-----------------------+  +----------------------+                  | |
|  +-------------------------------------------------------------------+   |
+============================================================================+

                              |
                    WSS (outbound, firewall-friendly)
                              |
                              v
+============================================================================+
|  TERMGRID RELAY SERVER (separate deployable)                               |
|                                                                            |
|  +-- Session Broker ---------+  +-- Auth ---------------+                  |
|  | Match host ↔ viewer       |  | Session tokens        |                  |
|  | Channel multiplexing      |  | Invite links          |                  |
|  | State sync on connect     |  | SSO/OIDC (optional)   |                  |
|  +---------------------------+  +------------------------+                  |
|                                                                            |
|  +-- E2E Encryption ---------+  +-- Audit Log -----------+                 |
|  | Relay cannot read content |  | Who connected when     |                 |
|  | Key exchange via signal   |  | Actions taken          |                 |
|  | protocol                  |  | Exportable             |                 |
|  +---------------------------+  +------------------------+                 |
+============================================================================+
```

---

## 9. Data Model

### 9.1 History Database (SQLite)

```sql
CREATE TABLE commands (
    id          INTEGER PRIMARY KEY,
    command     TEXT NOT NULL,
    shell       TEXT NOT NULL,        -- 'powershell', 'bash', 'zsh', etc.
    cwd         TEXT,                 -- working directory at time of execution
    pane_id     TEXT,                 -- which pane it ran in
    tab_name    TEXT,                 -- which tab
    exit_code   INTEGER,             -- NULL if still running or unknown
    duration_ms INTEGER,             -- execution time
    timestamp   DATETIME NOT NULL,
    project     TEXT,                 -- derived from cwd or .termgrid.json
    favorite    BOOLEAN DEFAULT 0,
    note        TEXT,                 -- user annotation
    redacted    BOOLEAN DEFAULT 0    -- if privacy filter matched
);

CREATE INDEX idx_commands_timestamp ON commands(timestamp DESC);
CREATE INDEX idx_commands_command ON commands(command);
CREATE INDEX idx_commands_cwd ON commands(cwd);
CREATE INDEX idx_commands_project ON commands(project);

-- Full-text search
CREATE VIRTUAL TABLE commands_fts USING fts5(command, note, content=commands);
```

### 9.2 Hook Configuration

```yaml
# .termgrid/hooks.yaml or per-project .termgrid.json
hooks:
  pre_execute:
    - name: "Confirm dangerous commands"
      match: "rm -rf|DROP TABLE|git push --force|git reset --hard"
      action: confirm
      message: "This is a destructive command. Are you sure?"
    
    - name: "Block secrets in commands"
      match: "password=|api_key=|secret="
      action: block
      message: "Command appears to contain secrets. Blocked."
    
    - name: "Auto dry-run in production"
      match: "kubectl delete|terraform destroy"
      condition: "env.ENVIRONMENT == 'production'"
      action: transform
      transform: "$COMMAND --dry-run"
  
  post_execute:
    - name: "Notify on long commands"
      condition: "duration > 30s"
      action: notify
      message: "Command finished: $COMMAND (took $DURATION)"
    
    - name: "Chain build → test"
      match: "npm run build"
      condition: "exit_code == 0"
      action: execute
      target_pane: "auto"  # or specific pane ID
      command: "npm test"
```

### 9.3 Relay Session

```json
{
  "session_id": "tg_sess_abc123",
  "host_id": "user@machine",
  "created_at": "2026-04-17T10:00:00Z",
  "expires_at": "2026-04-17T14:00:00Z",
  "shared_panes": ["pane-1", "pane-3"],
  "viewers": [
    {
      "id": "viewer-xyz",
      "name": "Alice",
      "mode": "interactive",
      "connected_at": "2026-04-17T10:05:00Z",
      "allowed_commands": ["ls", "cat", "git status"],
      "blocked_commands": ["rm", "sudo"]
    }
  ],
  "encryption": {
    "algorithm": "X25519+ChaCha20-Poly1305",
    "host_public_key": "...",
    "viewer_public_key": "..."
  }
}
```

---

## 10. Phased Delivery

### Phase 1 — Foundation (MVP)
- Tauri app with xterm.js
- PTY management via portable-pty
- Auto-tiling layout (1-6 panes)
- Tabs with drag-drop reorder
- Native Ctrl+C/V/F
- Shell selection (PowerShell, CMD, bash, zsh)
- Basic settings UI (theme, font, default shell)
- Windows + macOS + Linux builds

### Phase 2 — History & Hooks
- SQLite command history with fuzzy search (Ctrl+R)
- Global + per-pane history views
- Pre/post execution hooks
- Command interception and confirmation dialogs
- Privacy filters for history
- Per-project settings (.termgrid.json)

### Phase 3 — Inter-Terminal & AI
- Inter-pane communication (pipe, broadcast, events)
- AI command bar (Ctrl+K)
- Inline command suggestions
- Error explanation
- Multi-provider AI (Claude, OpenAI, Ollama)
- AI context assembly (recent output + history + cwd)

### Phase 4 — Relay & Sharing
- Relay server (deployable as Docker container or binary)
- Outbound WebSocket connection (firewall-friendly)
- E2E encryption
- Session sharing (view-only, interactive, collaborative)
- Auth (tokens, invite links, optional SSO)
- Audit logging
- Access controls (command whitelist/blacklist for viewers)

### Phase 5 — Polish
- Layout presets (save/load)
- Theme marketplace / import
- SSH session support
- Session persistence across restarts
- Plugin/extension system
- Keybinding import (from iTerm2, Windows Terminal, etc.)
- Command palette (Ctrl+Shift+P)

---

## 11. Tech Stack Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| App framework | Tauri 2.0 | Small bundle, Rust backend, native window |
| Frontend | TypeScript + xterm.js | Proven terminal rendering, easy tiling UI |
| PTY | portable-pty (Rust) | Cross-platform, ConPTY on Windows, battle-tested |
| Terminal parsing | termwiz (Rust) | VTE parsing from WezTerm, MIT |
| History DB | SQLite via rusqlite | Fast, embedded, full-text search |
| AI | reqwest + streaming | Multi-provider HTTP calls |
| Relay | tokio + tokio-tungstenite | Async WebSocket, high performance |
| E2E encryption | x25519-dalek + chacha20poly1305 | Proven crypto crates |
| Build/package | Tauri CLI + GitHub Actions | Cross-platform CI/CD |
| Frontend framework | Solid.js or vanilla TS | Lightweight, fast reactivity |
