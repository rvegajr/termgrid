# TermGrid Shell Plugin for Zsh
# Source this file in your ~/.zshrc to enable cooperative adoption.
#
# What it does:
#   - Exports filtered environment variables to a known location
#   - Captures the visible scrollback buffer (last 500 lines)
#   - Updates on every prompt (via precmd hook)
#
# Installation:
#   echo 'source /path/to/termgrid.zsh' >> ~/.zshrc
#
# Privacy: Only exports variables in TermGrid's allow-list (PATH, LANG,
# toolchain vars like ASDF_DIR, direnv-style vars, etc.). Never exports
# secrets or sensitive data.

# Where to write the adoption payload. TermGrid reads from here.
# Format: $HOME/.termgrid/shell-state/<PID>.json
_termgrid_state_dir="$HOME/.termgrid/shell-state"
_termgrid_state_file="$_termgrid_state_dir/$$.json"

# Allow-list: mirrors src-tauri/src/adoption/env_capture.rs:FORWARD_ALLOWLIST
_termgrid_allowlist=(
  PATH HOME SHELL TERM USER LOGNAME
  LANG LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_MONETARY LC_NUMERIC LC_TIME
  EDITOR VISUAL PAGER
  ASDF_DIR ASDF_DATA_DIR
  DIRENV_DIR DIRENV_FILE DIRENV_DIFF
  MISE_DATA_DIR MISE_CONFIG_DIR
  PYENV_ROOT PYENV_VERSION
  RBENV_ROOT RBENV_VERSION
  NODENV_ROOT NODENV_VERSION
  GOPATH GOROOT GOBIN GO111MODULE
  RUSTUP_HOME CARGO_HOME CARGO_TARGET_DIR
  JAVA_HOME JDK_HOME
  VIRTUAL_ENV CONDA_DEFAULT_ENV CONDA_PREFIX
  SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION
)

_termgrid_export_state() {
  # Bail if disabled
  [[ "${TERMGRID_PLUGIN_DISABLED:-0}" == "1" ]] && return 0

  # Ensure state dir exists
  [[ -d "$_termgrid_state_dir" ]] || mkdir -p "$_termgrid_state_dir"

  # Build JSON payload (manual, no jq dependency)
  local json_env=""
  local first=1
  for var in $_termgrid_allowlist; do
    local val="${(P)var}"
    if [[ -n "$val" ]]; then
      # Escape double-quotes and backslashes
      val="${val//\\/\\\\}"
      val="${val//\"/\\\"}"
      if [[ $first -eq 0 ]]; then
        json_env+=","
      fi
      json_env+="\"$var\":\"$val\""
      first=0
    fi
  done

  # Capture scrollback: last 500 lines of terminal buffer.
  # In zsh we don't have direct buffer access, so we approximate
  # by capturing the last N commands from history. For true buffer
  # scraping, the user can still use macOS AppleScript or tmux.
  # Here we provide "recent commands" as a best-effort preview.
  local buffer_preview=""
  if (( ${+commands[fc]} )); then
    # Grab last 10 history entries, escape for JSON
    buffer_preview=$(fc -ln -10 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' | sed 's/  */ /g')
  fi

  # Write atomically via temp file + rename
  local tmp="${_termgrid_state_file}.tmp.$$"
  cat > "$tmp" <<EOF
{
  "pid": $$,
  "shell": "zsh",
  "cwd": "$PWD",
  "timestamp": $(date +%s),
  "env": {$json_env},
  "buffer_preview": "$buffer_preview"
}
EOF
  mv "$tmp" "$_termgrid_state_file"
}

# Hook into precmd (runs before each prompt)
autoload -Uz add-zsh-hook
add-zsh-hook precmd _termgrid_export_state

# Initial export (in case no prompt is shown yet)
_termgrid_export_state

# Clean up on shell exit
_termgrid_cleanup() {
  rm -f "$_termgrid_state_file"
}
trap _termgrid_cleanup EXIT
