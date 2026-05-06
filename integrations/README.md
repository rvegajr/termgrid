# File-manager integrations

TermGrid registers a `termgrid://` URL scheme so file managers can open folders directly into the running app. Three modes:

| Mode | What happens |
|---|---|
| `existing` | `cd <path>` in the currently focused pane (the last one you clicked / typed in). |
| `unused`   | Spawns a fresh pane in the active tab and `cd`s it to `<path>`. Auto-tile resizes the rest. |
| `new-tab`  | Always opens a brand-new tab named after the folder. |

The URL format is:

```
termgrid://open?path=<URL-encoded-absolute-path>&mode=<existing|unused|new-tab>
```

The platform-specific bits below all build that URL and hand it to the OS, which routes it to TermGrid (launching it if it isn't already running).

## macOS — Finder Quick Actions

```bash
bash integrations/macos/build-quick-actions.sh
cp -R "integrations/macos/build/"*.workflow ~/Library/Services/
/System/Library/CoreServices/pbs -flush
```

Now right-click any folder in Finder → **Quick Actions** → pick the variant.

To uninstall: `rm -rf ~/Library/Services/"Open in TermGrid"*.workflow`.

## Windows — Explorer context menu

Double-click [windows/install-explorer-menu.reg](windows/install-explorer-menu.reg). It adds three entries to the right-click menu, both when right-clicking a folder and when right-clicking inside a folder.

To uninstall: double-click [windows/uninstall-explorer-menu.reg](windows/uninstall-explorer-menu.reg).

The registry assumes TermGrid is installed at `%LOCALAPPDATA%\Programs\TermGrid\TermGrid.exe` (the default location for the Tauri MSI). If you installed elsewhere, edit the `Icon` lines.

## Linux — Nautilus / GNOME Files / Caja

```bash
bash integrations/linux/install.sh
nautilus -q  # restart Nautilus so it picks up the new actions
```

Right-click any folder → **Open in TermGrid (…)**.

To uninstall: `rm ~/.local/share/file-manager/actions/termgrid-*.desktop`.

For other file managers (Thunar, Dolphin, PCManFM) the same `.desktop` files often work but may need to live under that manager's actions directory. Patches welcome.

## How it routes back into the app

The deep-link plumbing is in [src/services/deep-link.ts](../src/services/deep-link.ts) (frontend parser + dispatch) and [tauri-plugin-deep-link](https://crates.io/crates/tauri-plugin-deep-link) on the Rust side. The scheme is declared in [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) under `plugins.deep-link.desktop.schemes`.

When the OS launches `termgrid://open?…` and the app isn't running, Tauri starts it; the URL is delivered as the first deep-link event. When the app *is* running, the OS focuses the existing window and delivers the URL there.
