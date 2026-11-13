# shellcheck shell=bash
# core.sh: configuration, helpers and the agent registry.
# Sourced by ../pd; defines functions and globals only, runs nothing.

# ---- configuration (env overrides, then optional config file) ---------------
PD_CONFIG_FILE="${PD_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/pd-menu/config}"
# shellcheck source=/dev/null
[ -f "$PD_CONFIG_FILE" ] && . "$PD_CONFIG_FILE"

PD_WORK_DIR="${PD_WORK_DIR:-$HOME/Work}"     # where workspaces live
PD_DEPTH="${PD_DEPTH:-2}"                     # folder levels below PD_WORK_DIR to search
PD_UI="${PD_UI:-auto}"                        # auto | dialog | whiptail | plain
PD_START_CHECK_SEC="${PD_START_CHECK_SEC:-3}" # how long a fresh window must survive
PD_TMUX_SOCKET="${PD_TMUX_SOCKET:-}"          # tmux -L <name>; empty = default server
# Directories never treated as workspaces (find -prune), space-separated names.
PD_PRUNE="${PD_PRUNE:-node_modules .git tmp local .venv venv dist build target}"

# Field separator of pd_sessions lines. Not TAB: read collapses empty
# whitespace fields, and the agent field is empty for foreign sessions.
# shellcheck disable=SC2034  # used by the other modules
PD_FS=$'\x1f'

pd_die()  { printf 'pd: %s\n' "$*" >&2; exit 1; }
pd_warn() { printf 'pd: %s\n' "$*" >&2; }

# tmux on the configured server. Every tmux call goes through here, which is
# what lets the tests run against a private socket.
pd_tmux() {
  if [ -n "$PD_TMUX_SOCKET" ]; then command tmux -L "$PD_TMUX_SOCKET" "$@"
  else command tmux "$@"; fi
}

pd_require() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || pd_die "needs '$c' in PATH"; done
}

# Same transformation polydaemon-claude.sh applies, so `pd-<name>` sessions we
# create are the ones its own `tmux new-session -A` would attach to.
pd_sanitize() {
  printf %s "$1" | tr -cs '[:alnum:]._-' '_' | tr -c '[:alnum:]_-' '-'
}

# "3m", "5h", "2d" from a number of seconds.
pd_ago() {
  local s=$1
  if   [ "$s" -lt 60 ];    then printf '%ss' "$s"
  elif [ "$s" -lt 3600 ];  then printf '%sm' $((s / 60))
  elif [ "$s" -lt 86400 ]; then printf '%sh' $((s / 3600))
  else printf '%sd' $((s / 86400)); fi
}

# Path relative to PD_WORK_DIR when inside it, else unchanged.
pd_rel() {
  case "$1" in
    "$PD_WORK_DIR") printf '.' ;;
    "$PD_WORK_DIR"/*) printf %s "${1#"$PD_WORK_DIR"/}" ;;
    *) printf %s "$1" ;;
  esac
}

# ---- agent registry ----------------------------------------------------------
# Each file in agents/ calls pd_agent_register once:
#   pd_agent_register <id> <label> <session-prefix> <launcher> [<launcher>...]
# id              short name used on the command line (claude, codex, ...)
# label           what the menu shows
# session-prefix  tmux sessions starting with it belong to this agent; the
#                 longest matching prefix wins, so "pd-" (Claude) is the fallback
# launcher        file names in a workspace, first existing one is used
# An agent file MAY also define, with <id> in the function name:
#   pd_agent_<id>_session <ws_dir>      -> session name for a new window
#   pd_agent_<id>_args <mode>           -> launcher args for mode resume|new
PD_AGENTS=()
declare -A PD_AGENT_LABEL PD_AGENT_PREFIX PD_AGENT_LAUNCHERS

pd_agent_register() {
  local id=$1 label=$2 prefix=$3; shift 3
  PD_AGENTS+=("$id")
  PD_AGENT_LABEL[$id]=$label
  PD_AGENT_PREFIX[$id]=$prefix
  PD_AGENT_LAUNCHERS[$id]="$*"
}

pd_agent_known() { [ -n "${PD_AGENT_LABEL[$1]+x}" ]; }

# Launcher path for agent $1 in workspace dir $2, or nothing.
pd_agent_launcher() {
  local f
  for f in ${PD_AGENT_LAUNCHERS[$1]}; do
    [ -f "$2/$f" ] && { printf '%s/%s' "$2" "$f"; return 0; }
  done
  return 1
}

# Session name for a new window of agent $1 in dir $2.
pd_agent_session() {
  if declare -F "pd_agent_$1_session" >/dev/null; then "pd_agent_$1_session" "$2"
  else printf '%s%s' "${PD_AGENT_PREFIX[$1]}" "$(pd_sanitize "$(basename "$2")")"; fi
}

# Launcher arguments for agent $1 and mode $2 (resume|new).
pd_agent_args() {
  if declare -F "pd_agent_$1_args" >/dev/null; then "pd_agent_$1_args" "$2"
  elif [ "$2" = new ]; then printf 'new'; fi
}

# Agent id owning tmux session $1 (longest prefix), or nothing.
pd_agent_of_session() {
  local id best="" bestlen=0 p
  for id in "${PD_AGENTS[@]}"; do
    p=${PD_AGENT_PREFIX[$id]}
    case "$1" in
      "$p"*) [ ${#p} -gt "$bestlen" ] && { best=$id; bestlen=${#p}; } ;;
    esac
  done
  [ -n "$best" ] && printf %s "$best"
}

pd_load_agents() {
  local f
  for f in "$PD_HOME"/agents/*.sh; do
    # shellcheck source=/dev/null
    [ -f "$f" ] && . "$f"
  done
  [ ${#PD_AGENTS[@]} -gt 0 ] || pd_die "no agents in $PD_HOME/agents"
}
