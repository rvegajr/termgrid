#!/usr/bin/env bash
# build-quick-actions.sh — generate the three TermGrid Finder Quick Actions.
#
# Output:
#   ./build/Open in TermGrid (New Tab).workflow/Contents/document.wflow
#   ./build/Open in TermGrid (Unused Pane).workflow/Contents/document.wflow
#   ./build/Open in TermGrid (Existing Pane).workflow/Contents/document.wflow
#
# Install one or more by copying to ~/Library/Services/ and logging out + in
# (or running `pkill -kill -u $USER Finder`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/build"
rm -rf "$OUT"
mkdir -p "$OUT"

make_workflow() {
  local name="$1"
  local mode="$2"
  local dir="$OUT/$name.workflow/Contents"
  mkdir -p "$dir"

  cat > "$dir/document.wflow" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>522</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><false/>
          <key>Types</key><array><string>com.apple.cocoa.path</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>for f in "\$@"; do
  enc=\$(/usr/bin/python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "\$f")
  /usr/bin/open "termgrid://open?path=\${enc}&amp;mode=$mode"
done</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>1</integer>
          <key>shell</key><string>/bin/bash</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>00000000-0000-0000-0000-000000000001</string>
        <key>Keywords</key><array><string>Shell</string><string>Script</string></array>
        <key>OutputUUID</key><string>00000000-0000-0000-0000-000000000002</string>
        <key>UUID</key><string>00000000-0000-0000-0000-000000000003</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
        <key>arguments</key>
        <dict>
          <key>0</key><dict><key>default value</key><integer>0</integer><key>name</key><string>inputMethod</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>0</string></dict>
          <key>1</key><dict><key>default value</key><false/><key>name</key><string>CheckedForUserDefaultShell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>1</string></dict>
          <key>2</key><dict><key>default value</key><string></string><key>name</key><string>source</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>2</string></dict>
          <key>3</key><dict><key>default value</key><string></string><key>name</key><string>COMMAND_STRING</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>3</string></dict>
          <key>4</key><dict><key>default value</key><string>/bin/sh</string><key>name</key><string>shell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>4</string></dict>
        </dict>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.500000:316.000000</string>
        <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceApplicationBundleID</key><string>com.apple.finder</string>
    <key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
EOF
}

make_workflow "Open in TermGrid (New Tab)" "new-tab"
make_workflow "Open in TermGrid (Unused Pane)" "unused"
make_workflow "Open in TermGrid (Existing Pane)" "existing"

echo "Built quick actions in: $OUT"
echo
echo "Install one (or all) with:"
for f in "$OUT"/*.workflow; do
  echo "  cp -R \"$f\" ~/Library/Services/"
done
echo
echo "Then either log out + in, or run:"
echo "  /System/Library/CoreServices/pbs -flush"
