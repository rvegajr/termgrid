# TermGrid Shell Plugins

These plugins enable **cooperative adoption**: your shell voluntarily exports its environment and buffer state to TermGrid, eliminating the need for platform-specific introspection hacks.

## Benefits

- **Cross-platform**: Works on macOS, Linux (X11/Wayland), and Windows
- **No elevated permissions**: No Accessibility API, no debugger entitlement
- **High fidelity**: Captures the exact environment (direnv, asdf, mise, pyenv, etc.)
- **Privacy-safe**: Only exports allow-listed variables (never secrets)

## Installation

### Zsh

Add to your `~/.zshrc`:

```bash
source ~/.termgrid/plugins/termgrid.zsh
```

### Bash

Add to your `~/.bashrc`:

```bash
source ~/.termgrid/plugins/termgrid.bash
```

### Fish

Add to your `~/.config/fish/config.fish`:

```fish
source ~/.termgrid/plugins/termgrid.fish
```

## How It Works

1. On every prompt, the plugin writes a JSON snapshot to `~/.termgrid/shell-state/<PID>.json`
2. TermGrid reads this file when adopting a session
3. The snapshot includes:
   - Filtered environment variables (PATH, LANG, toolchain vars, etc.)
   - Recent command history as a buffer preview
   - Current working directory
   - Shell type

## Privacy

The plugins **never** export:
- Secrets (AWS keys, tokens, passwords)
- Private environment variables outside the allow-list
- Full terminal buffer content (only recent history)

## Disabling

To temporarily disable the plugin without removing it:

```bash
export TERMGRID_PLUGIN_DISABLED=1
```

## Troubleshooting

If TermGrid isn't picking up your shell state:

1. Verify the plugin is sourced: `type _termgrid_export_state` should return a function definition
2. Check the state file exists: `ls ~/.termgrid/shell-state/$$.json`
3. Ensure the file is fresh: it should update on every prompt

For issues, file a bug at https://github.com/your-repo/termgrid/issues
