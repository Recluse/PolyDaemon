#!/usr/bin/env bash
# polydaemon-claude.sh — macOS/Linux per-workspace launcher (companion to Windows
# polydaemon-claude.cmd). Drop a copy in each workspace root (or symlink it), then run it
# from that workspace. Launches claude with the tg-bridge dev channel and the same
# flags as Windows:
#   --name <folder>                       bot/registry identify the window by workspace
#   --continue                            resume this workspace's last session
#                                         (graceful — starts fresh if there's none)
#   --permission-mode bypassPermissions
#   --settings {autoCompactEnabled:false} keep the FULL session — a large resume
#                                         otherwise gets auto-compacted immediately
#                                         (set TG_KEEP_AUTOCOMPACT=1 to opt out).
# Extra args pass through:  ./polydaemon-claude.sh --model claude-opus-4-8
#
# The plugin's networking env (TG_BRIDGE_BOT_URL → the bot on the bot host, TG_API_ROOT,
# TG_BRIDGE_BIND_HOST / TG_BRIDGE_ADVERTISE_HOST = this device's mesh IP, the shared
# TG_BRIDGE_AUTH_TOKEN, …) comes from the tg-bridge MCP server entry in
# ~/.claude.json — see clients/README.md.
#
set -euo pipefail
if [ "${1:-}" = new ]; then
  shift
  export TG_CLAUDE_NEW=1
  for arg in "$@"; do
    case "$arg" in
      --continue|-c|--resume|--resume=*|-r|--fork-session)
        echo 'polydaemon-claude: new cannot continue, resume or fork a session' >&2; exit 2 ;;
    esac
  done
fi
# Claude auto-update churns the binary path daily → macOS re-asks every TCC
# (folder/automation) permission each version. Pin the running version per
# session so grants stick; update deliberately.
export DISABLE_AUTOUPDATER=1

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# TG_WS_NAME overrides the window name — set it when another device runs a
# window off the same-named folder (the bot keys windows by NAME, so two
# devices sharing one name collide and the later one steals the window).
# printf (not a pipe from basename) so tr never sees the trailing newline —
# piped, it became a trailing '_' in the name (e.g. "myproject_").
NAME="${TG_WS_NAME:-$(printf %s "$(basename "$PWD")" | tr -cs '[:alnum:]._-' '_')}"
# `claude --name` never reaches the channel plugin — its registered identity
# comes from TG_BRIDGE_INSTANCE_NAME (else basename(cwd)). Export so the bot
# sees the same name claude does.
export TG_BRIDGE_INSTANCE_NAME="$NAME"
# Inside tmux, the bot can type into the window (/compact, /model, /restart,
# idle compaction): the plugin sends the keys to its own pane. That is the only
# way to do it on Linux, and on macOS outside iTerm2. TG_TMUX=1 starts the window
# in a tmux session named pd-<name> (reattach with `tmux attach -t pd-<name>`);
# default on Linux when tmux is installed, off on macOS, where iTerm2 does it.
case "${TG_TMUX:-auto}" in
  auto) [ "$(uname -s)" = Linux ] && command -v tmux >/dev/null 2>&1 && TG_TMUX=1 || TG_TMUX=0 ;;
esac
if [ "$TG_TMUX" = 1 ] && [ -z "${TMUX:-}" ]; then
  # Carry THIS environment into the pane. A pane gets the tmux SERVER's
  # environment, so with a server already running TG_WS_NAME, CLAUDE_* and the
  # rest were silently lost. The file is 0600 (mktemp) and deleted at once.
  ENVF="$(mktemp)"
  export -p > "$ENVF"
  # Absolute: we cd'd to the script's folder, so a relative $0 no longer resolves.
  SELF="$PWD/$(basename "${BASH_SOURCE[0]}")"
  ATTACH=-A
  [ "${TG_CLAUDE_NEW:-0}" != 1 ] || ATTACH=""
  exec tmux new-session $ATTACH -s "pd-$(printf %s "$NAME" | tr -c '[:alnum:]_-' '-')" -c "$PWD" \
    bash -c '. "$1"; rm -f "$1"; shift; exec bash "$@"' _ "$ENVF" "$SELF" "$@"
fi
# This launcher always passes the channels flag below, so tell the plugin so
# rather than have it inspect its parent's command line to find out.
export TG_BRIDGE_FORCE_CHANNELS=1
# The plugin treats CLAUDE_CODE_ENTRYPOINT=sdk-cli as a headless run and stays
# out of the registry; a window started from inside another claude would inherit
# it, and Claude Code keeps an inherited value. This is a window: clear it.
unset CLAUDE_CODE_ENTRYPOINT

# A per-WINDOW identity, minted here and inherited by everything claude spawns:
# the channel plugin AND every hook. Names and cwd are both ambiguous — the same
# folder is routinely open in two live windows at once (a terminal claude and one
# inside Zed, measured 2026-09-18), so a hook could not tell which plugin was its
# own. The launcher is the only place above both of them, which is why the window
# NAME is already exported the same way a few lines up.
#
# Windows started outside this launcher (Zed's external agent starts claude
# itself) get no uid, so consumers must keep their fallbacks.
if [ -z "${TG_WINDOW_UID:-}" ]; then
  if command -v uuidgen >/dev/null 2>&1; then
    TG_WINDOW_UID="$(uuidgen)"
  else
    TG_WINDOW_UID="$$-$(date +%s)"   # good enough: unique per live process
  fi
fi
export TG_WINDOW_UID

# --continue only when this workspace already has a session on THIS machine —
# claude errors out on --continue with nothing to continue (a freshly copied
# workspace hits this). Project dir encoding: every non-alphanumeric char of
# the cwd becomes '-' (verified against live ~/.claude/projects entries).
#
# Use the PHYSICAL path here, not $PWD. An alias workspace (a symlink, or a
# Windows junction used to give another workspace a second name) is entered by
# its alias path, but
# claude resolves it and stores the transcript under the REAL path. Keying this
# lookup on the alias meant the directory never existed, so --continue was
# silently never passed and such a window always started blank while its history
# sat intact under the real path (found on the Windows twin, 2026-09-09).
# The window NAME below deliberately stays on the logical path — that alias is
# the whole point of the twin.
RESUME=""
PROJ_DIR="$HOME/.claude/projects/$(printf %s "$(pwd -P)" | tr -c '[:alnum:]' '-')"
if [ "${TG_CLAUDE_NEW:-0}" != 1 ] && ls "$PROJ_DIR"/*.jsonl >/dev/null 2>&1; then
  RESUME="--continue"
fi

# Two exec branches (no arrays) so this stays correct on macOS's stock bash 3.2,
# where expanding an empty array under `set -u` would error. $RESUME is
# deliberately unquoted: empty → zero words, set → one flag.
if [ "${TG_KEEP_AUTOCOMPACT:-}" != "1" ]; then
  NOCOMPACT="$HOME/.tg-bridge-channel/launch-no-autocompact.json"
  mkdir -p "$(dirname "$NOCOMPACT")"
  printf '{"autoCompactEnabled":false}' > "$NOCOMPACT"
  exec claude --dangerously-load-development-channels server:tg-bridge \
    $RESUME --name "$NAME" --permission-mode bypassPermissions \
    --settings "$NOCOMPACT" "$@"
else
  exec claude --dangerously-load-development-channels server:tg-bridge \
    $RESUME --name "$NAME" --permission-mode bypassPermissions "$@"
fi
