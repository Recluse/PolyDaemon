# shellcheck shell=bash
# workspaces.sh: find PolyDaemon workspaces under PD_WORK_DIR.
# A workspace is any directory holding at least one registered agent launcher.
# Nothing is cached: new folders show up on the next menu refresh.

# All launcher file names of all agents, for find.
pd__launcher_names() {
  local id f
  for id in "${PD_AGENTS[@]}"; do
    for f in ${PD_AGENT_LAUNCHERS[$id]}; do printf '%s\n' "$f"; done
  done | sort -u
}

# Prints workspace directories, one per line, sorted by relative path.
pd_ws_list() {
  local -a expr=() prune=() n
  local first=1
  for n in $PD_PRUNE; do
    [ ${#prune[@]} -gt 0 ] && prune+=(-o)
    prune+=(-name "$n")
  done
  while IFS= read -r n; do
    [ $first = 1 ] || expr+=(-o)
    expr+=(-name "$n"); first=0
  done < <(pd__launcher_names)
  [ -d "$PD_WORK_DIR" ] || return 0
  find "$PD_WORK_DIR" -maxdepth "$((PD_DEPTH + 1))" \
      \( -type d \( "${prune[@]}" \) -prune \) -o \
      \( -type f \( "${expr[@]}" \) -print \) 2>/dev/null \
    | while IFS= read -r f; do dirname "$f"; done \
    | sort -u
}

# Agent ids that have a launcher in workspace dir $1.
pd_ws_agents() {
  local id
  for id in "${PD_AGENTS[@]}"; do
    pd_agent_launcher "$id" "$1" >/dev/null && printf '%s\n' "$id"
  done
}

# Resolve a user-given workspace (relative path, basename or absolute path)
# to a directory. Fails when nothing or more than one matches.
pd_ws_resolve() {
  local want=$1 d hits=()
  [ -d "$want" ] && { (cd "$want" && pwd -P); return; }
  while IFS= read -r d; do
    if [ "$(pd_rel "$d")" = "$want" ] || [ "$(basename "$d")" = "$want" ]; then
      hits+=("$d")
    fi
  done < <(pd_ws_list)
  case ${#hits[@]} in
    1) printf %s "${hits[0]}" ;;
    0) pd_warn "no workspace '$want' under $PD_WORK_DIR"; return 1 ;;
    *) pd_warn "'$want' is ambiguous: ${hits[*]}"; return 1 ;;
  esac
}
