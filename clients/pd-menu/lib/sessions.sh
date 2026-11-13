# shellcheck shell=bash
# sessions.sh: list, start, attach and stop PolyDaemon tmux windows.

# One line per tmux session, fields separated by PD_FS:
#   name  agent  ws_dir  attached  idle_sec  age_sec  pane_cmd  dead
# agent is empty for sessions no registered agent owns.
pd_sessions() {
  local now name path att act created cmd dead wact agent
  now=$(date +%s)
  pd_tmux list-sessions -F \
    '#{session_name}	#{session_path}	#{session_attached}	#{session_activity}	#{session_created}' \
    2>/dev/null |
  while IFS=$'\t' read -r name path att act created; do
    # First pane of the first window is the agent itself (codex adds a sidebar
    # pane next to it). A plain shell there means the agent has exited.
    # window_activity is the last OUTPUT; session_activity only counts typing.
    IFS=$'\t' read -r cmd dead wact < <(pd_tmux list-panes -t "=$name:" -F \
      '#{pane_current_command}	#{pane_dead}	#{window_activity}' 2>/dev/null | head -n1)
    [ -n "${wact:-}" ] && [ "$wact" -gt "$act" ] && act=$wact
    agent=$(pd_agent_of_session "$name")
    printf "%s$PD_FS%s$PD_FS%s$PD_FS%s$PD_FS%s$PD_FS%s$PD_FS%s$PD_FS%s\n" "$name" "$agent" "$path" "$att" \
      $((now - act)) $((now - created)) "${cmd:-?}" "${dead:-0}"
  done
}

# Only PolyDaemon sessions (those an agent owns).
pd_sessions_pd() { pd_sessions | awk -F"$PD_FS" '$2 != ""'; }

# Sessions of agent $1 in workspace dir $2, names only.
pd_sessions_for() {
  pd_sessions_pd | awk -F"$PD_FS" -v a="$1" -v d="$2" '$2 == a && $3 == d { print $1 }'
}

pd_session_exists() { pd_tmux has-session -t "=$1" 2>/dev/null; }

# Human status of a session line (fields as pd_sessions prints).
pd_session_status() {
  local att=$1 idle=$2 cmd=$3 dead=$4 s
  if [ "$dead" = 1 ]; then s='✖ панель завершилась'
  else
    case "$cmd" in
      bash|zsh|sh|fish|dash) s='⚠ агент вышел, в панели shell' ;;
      *) if [ "$att" -gt 0 ]; then s="● подключено ($att)"; else s='○ в фоне'; fi ;;
    esac
  fi
  printf '%s, активность %s назад' "$s" "$(pd_ago "$idle")"
}

# Attach to session $1. Inside tmux, switch this client instead of nesting.
# $2 = 1 detaches every other client first (takes over the window size).
pd_attach() {
  local s=$1 excl=${2:-0}
  pd_session_exists "$s" || { pd_warn "no session $s"; return 1; }
  if [ -n "${TMUX:-}" ] && [ -z "$PD_TMUX_SOCKET" ]; then
    pd_tmux switch-client -t "=$s"
  elif [ "$excl" = 1 ]; then
    pd_tmux attach-session -d -t "=$s"
  else
    pd_tmux attach-session -t "=$s"
  fi
}

pd_kill() { pd_tmux kill-session -t "=$1"; }

# First free name: $1, then $1-2, $1-3, ...
pd__free_name() {
  local base=$1 n=2 name=$1
  while pd_session_exists "$name"; do name="$base-$n"; n=$((n + 1)); done
  printf %s "$name"
}

# Start agent $1 in workspace dir $2, mode $3 (resume|new), detached.
# Prints the session name on success. On a quick failure prints the pane's
# last lines to stderr and removes the dead session.
pd_start() {
  local agent=$1 dir=$2 mode=${3:-resume} launcher name envf args cols lines out
  launcher=$(pd_agent_launcher "$agent" "$dir") ||
    { pd_warn "$agent has no launcher in $dir"; return 1; }
  name=$(pd__free_name "$(pd_agent_session "$agent" "$dir")")
  args=$(pd_agent_args "$agent" "$mode")

  # The pane gets the tmux SERVER's environment, not ours; carry ours over the
  # same way polydaemon-claude.sh does. TMUX/TMUX_PANE must not leak in: the
  # launchers read them to decide whether they are already inside a pane.
  envf=$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pd-env.XXXXXX") || return 1
  env -u TMUX -u TMUX_PANE bash -c 'export -p' > "$envf"

  ui__size
  cols=$UI_COLS; lines=$UI_LINES
  # The launcher is the pane's first process (a login shell first could clear
  # the screen and race with it). After it exits the wrapper sleeps 0.5 s:
  # that is the window in which remain-on-exit gets set, and it keeps the pty
  # open until tmux has read the last lines. So a launcher that fails at once
  # leaves its error on screen for us to show.
  # Variables inside bash -c are expanded by the child, not this shell.
  # shellcheck disable=SC2086,SC2016  # $args is a word list by design
  pd_tmux new-session -d -s "$name" -c "$dir" -x "$cols" -y "$lines" \
    bash -c '. "$1"; rm -f "$1"; shift; "$@"; rc=$?; sleep 0.5; exit $rc' _ "$envf" "$launcher" $args \
    || { rm -f "$envf"; return 1; }
  pd_tmux set-option -w -t "=$name:" remain-on-exit on 2>/dev/null

  sleep "$PD_START_CHECK_SEC"
  if ! pd_session_exists "$name"; then
    rm -f "$envf"
    pd_warn "window $name closed immediately (no output captured)"
    return 1
  fi
  if [ "$(pd_tmux list-panes -t "=$name:" -F '#{pane_dead}' 2>/dev/null | head -n1)" = 1 ]; then
    out=$(pd_tmux capture-pane -p -S - -t "=$name:" 2>/dev/null | sed '/^$/d' | tail -n 15)
    pd_kill "$name" 2>/dev/null
    rm -f "$envf"
    printf '%s\n' "$out" >&2
    return 1
  fi
  pd_tmux set-option -w -t "=$name:" remain-on-exit off 2>/dev/null
  printf %s "$name"
}
