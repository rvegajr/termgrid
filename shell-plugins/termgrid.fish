# TermGrid Shell Plugin for Fish
# Source this file in your ~/.config/fish/config.fish to enable cooperative adoption.
#
# What it does:
#   - Exports filtered environment variables to a known location
#   - Captures recent command history as a buffer preview
#   - Updates on every prompt (via fish_prompt event)
#
# Installation:
#   echo 'source /path/to/termgrid.fish' >> ~/.config/fish/config.fish
#
# Privacy: Only exports variables in TermGrid's allow-list.

# Where to write the adoption payload
set -g _termgrid_state_dir "$HOME/.termgrid/shell-state"
set -g _termgrid_state_file "$_termgrid_state_dir/$fish_pid.json"

# Allow-list
set -g _termgrid_allowlist \
  PATH HOME SHELL TERM USER LOGNAME \
  LANG LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_MONETARY LC_NUMERIC LC_TIME \
  EDITOR VISUAL PAGER \
  ASDF_DIR ASDF_DATA_DIR \
  DIRENV_DIR DIRENV_FILE DIRENV_DIFF \
  MISE_DATA_DIR MISE_CONFIG_DIR \
  PYENV_ROOT PYENV_VERSION \
  RBENV_ROOT RBENV_VERSION \
  NODENV_ROOT NODENV_VERSION \
  GOPATH GOROOT GOBIN GO111MODULE \
  RUSTUP_HOME CARGO_HOME CARGO_TARGET_DIR \
  JAVA_HOME JDK_HOME \
  VIRTUAL_ENV CONDA_DEFAULT_ENV CONDA_PREFIX \
  SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION

function _termgrid_export_state --on-event fish_prompt
  # Bail if disabled
  if test "$TERMGRID_PLUGIN_DISABLED" = "1"
    return 0
  end

  # Ensure state dir exists
  test -d "$_termgrid_state_dir"; or mkdir -p "$_termgrid_state_dir"

  # Build JSON env object
  set -l json_env ""
  set -l first 1
  for var in $_termgrid_allowlist
    set -l val $$var
    if test -n "$val"
      # Escape for JSON
      set val (string replace -a '\\' '\\\\' -- "$val")
      set val (string replace -a '"' '\\"' -- "$val")
      if test $first -eq 0
        set json_env "$json_env,"
      end
      set json_env "$json_env\"$var\":\"$val\""
      set first 0
    end
  end

  # Capture recent history
  set -l buffer_preview ""
  if command -q history
    set buffer_preview (history --max=10 | string replace -a '\\' '\\\\' | string replace -a '"' '\\"' | string join ' ')
  end

  # Write atomically
  set -l tmp "$_termgrid_state_file.tmp.$fish_pid"
  echo "{
  \"pid\": $fish_pid,
  \"shell\": \"fish\",
  \"cwd\": \"$PWD\",
  \"timestamp\": "(date +%s)",
  \"env\": {$json_env},
  \"buffer_preview\": \"$buffer_preview\"
}" > $tmp
  mv $tmp $_termgrid_state_file
end

# Initial export
_termgrid_export_state

# Clean up on shell exit
function _termgrid_cleanup --on-event fish_exit
  rm -f $_termgrid_state_file
end
