# TermGrid Shell Plugin for Bash
# Source this file in your ~/.bashrc to enable cooperative adoption.
#
# What it does:
#   - Exports filtered environment variables to a known location
#   - Captures recent command history as a buffer preview
#   - Updates on every prompt (via PROMPT_COMMAND)
#
# Installation:
#   echo 'source /path/to/termgrid.bash' >> ~/.bashrc
#
# Privacy: Only exports variables in TermGrid's allow-list. Never exports
# secrets or sensitive data.

# Where to write the adoption payload
_termgrid_state_dir="$HOME/.termgrid/shell-state"
_termgrid_state_file="$_termgrid_state_dir/$$.json"

# Allow-list: mirrors the Rust FORWARD_ALLOWLIST
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

  # Build JSON env object
  local json_env=""
  local first=1
  for var in "${_termgrid_allowlist[@]}"; do
    local val="${!var}"
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

  # Capture recent history as buffer preview
  local buffer_preview=""
  if command -v history &>/dev/null; then
    buffer_preview=$(history 10 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' | sed 's/  */ /g')
  fi

  # Write atomically
  local tmp="${_termgrid_state_file}.tmp.$$"
  cat > "$tmp" <<EOF
{
  "pid": $$,
  "shell": "bash",
  "cwd": "$PWD",
  "timestamp": $(date +%s),
  "env": {$json_env},
  "buffer_preview": "$buffer_preview"
}
EOF
  mv "$tmp" "$_termgrid_state_file"
}

# Hook into PROMPT_COMMAND
if [[ -z "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="_termgrid_export_state"
else
  PROMPT_COMMAND="${PROMPT_COMMAND};_termgrid_export_state"
fi

# Initial export
_termgrid_export_state

# Clean up on shell exit
_termgrid_cleanup() {
  rm -f "$_termgrid_state_file"
}
trap _termgrid_cleanup EXIT
