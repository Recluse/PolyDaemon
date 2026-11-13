#!/usr/bin/env bash
# Smoke test: fake workspaces with stub launchers on a private tmux server.
# Never touches real sessions. Usage: tests/smoke.sh [scratch-dir]
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${1:-$HERE/tests/.scratch}"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/work/Alpha" "$SCRATCH/work/Beta/sub" "$SCRATCH/work/Gamma/node_modules/x"
export PD_WORK_DIR="$SCRATCH/work" PD_TMUX_SOCKET="pd-smoke-$$" PD_START_CHECK_SEC=1 PD_NO_ATTACH=1
fail=0; ok() { printf 'ok   %s\n' "$1"; }; bad() { printf 'FAIL %s\n' "$1"; fail=1; }
cleanup() { tmux -L "$PD_TMUX_SOCKET" kill-server 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

stub() { # stub <file> <body>
  printf '#!/usr/bin/env bash\n%s\n' "$2" > "$1"; chmod +x "$1"
}
# Records its args, whether it runs inside tmux, then stays alive.
stub "$SCRATCH/work/Alpha/polydaemon-claude.sh" 'echo "args=$* tmux=${TMUX:+yes} pane=${TMUX_PANE:-}" > "$(dirname "$0")/ran-claude"; exec sleep 300'
stub "$SCRATCH/work/Alpha/polydaemon-codex.sh"  'echo "args=$*" > "$(dirname "$0")/ran-codex"; exec sleep 300'
stub "$SCRATCH/work/Beta/sub/polydaemon-claude.sh" 'echo "boom: not logged in" >&2; exit 3'
stub "$SCRATCH/work/Gamma/node_modules/x/polydaemon-claude.sh" 'exit 0'
tmux -L "$PD_TMUX_SOCKET" new-session -d -s keepalive 'sleep 300'

ws=$("$HERE/pd" ws)
grep -q '^Alpha .*claude codex' <<<"$ws" && ok "ws finds Alpha with claude+codex" || bad "ws Alpha: $ws"
grep -q '^Beta/sub ' <<<"$ws" && ok "ws finds nested Beta/sub" || bad "ws Beta/sub: $ws"
grep -q node_modules <<<"$ws" && bad "ws must prune node_modules" || ok "ws prunes node_modules"

s=$("$HERE/pd" start Alpha claude) && [ "$s" = pd-Alpha ] && ok "start claude -> $s" || bad "start claude: $s"
grep -q 'args= tmux=yes pane=%' "$SCRATCH/work/Alpha/ran-claude" 2>/dev/null \
  && ok "launcher ran inside tmux with resume args" || bad "ran-claude: $(cat "$SCRATCH/work/Alpha/ran-claude" 2>&1)"
s2=$("$HERE/pd" start Alpha claude) && [ "$s2" = pd-Alpha ] && ok "resume reuses running window" || bad "resume reuse: $s2"
s3=$("$HERE/pd" start Alpha claude new) && [ "$s3" = pd-Alpha-2 ] && ok "new gets its own name $s3" || bad "new: $s3"
s4=$("$HERE/pd" start Alpha codex new) && [ "$s4" = pd-codex-Alpha ] && ok "codex -> $s4" || bad "codex: $s4"
grep -q '^args=new$' "$SCRATCH/work/Alpha/ran-codex" 2>/dev/null && ok "codex got 'new'" || bad "ran-codex"

ls=$("$HERE/pd" ls)
grep -q '^pd-codex-Alpha  *codex  *Alpha ' <<<"$ls" && ok "ls maps codex session to Alpha" || bad "ls codex: $ls"
grep -q '^pd-Alpha  *claude  *Alpha ' <<<"$ls" && ok "ls maps claude session" || bad "ls claude: $ls"
grep -q '^keepalive  *tmux ' <<<"$ls" && ok "ls shows foreign tmux sessions" || bad "ls foreign: $ls"

err=$("$HERE/pd" start Beta/sub claude 2>&1) && bad "failing launcher reported success" \
  || { grep -q 'boom: not logged in' <<<"$err" && ok "failure shows launcher output" || bad "failure output: $err"; }
tmux -L "$PD_TMUX_SOCKET" has-session -t =pd-sub 2>/dev/null && bad "dead session left behind" || ok "dead session removed"

"$HERE/pd" start Nope 2>/dev/null && bad "unknown ws accepted" || ok "unknown ws rejected"
exit $fail
