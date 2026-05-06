#!/usr/bin/env bash
# install.sh — wire TermGrid into Nautilus / GNOME Files / Caja right-click.
#
# Drops three .desktop "actions" into ~/.local/share/file-manager/actions/.
# Works with file-manager-actions / Nautilus 4+ / Caja (MATE).

set -euo pipefail

DEST="$HOME/.local/share/file-manager/actions"
mkdir -p "$DEST"

write_action() {
  local id="$1" name="$2" mode="$3"
  cat > "$DEST/termgrid-$id.desktop" <<EOF
[Desktop Entry]
Type=Action
Name=$name
Icon=utilities-terminal
Profiles=primary;
TargetLocation=true
TargetContext=true

[X-Action-Profile primary]
MimeTypes=inode/directory;
SelectionCount=1
Exec=xdg-open "termgrid://open?path=%f&mode=$mode"
EOF
}

write_action "unused"   "Open in TermGrid (Unused Pane)"   "unused"
write_action "existing" "Open in TermGrid (Existing Pane)" "existing"
write_action "newtab"   "Open in TermGrid (New Tab)"       "new-tab"

echo "Installed 3 file-manager actions to: $DEST"
echo "Restart your file manager (e.g. nautilus -q) to see them in the right-click menu."
