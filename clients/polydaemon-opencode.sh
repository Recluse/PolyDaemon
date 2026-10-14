#!/usr/bin/env bash
# OpenCode V2 window with the Telegram bridge plugin.
set -euo pipefail
if [ "${1:-}" = new ]; then
  shift
  export TG_OPENCODE_NEW=1
fi
# Parse selectors without mistaking option values or text after -- for flags.
EXPLICIT=0
POSITIONAL=""
EXPECT_VALUE=0
for arg in "$@"; do
  if [ "$EXPECT_VALUE" = 1 ]; then EXPECT_VALUE=0; continue; fi
  [ "$arg" != -- ] || break
  case "$arg" in --session|--session=*|--session-id|--session-id=*|--resume|--resume=*|--continue|--continue=*|--fork|--fork=*|--fork-session|--fork-session=*|-s|-r|-c) EXPLICIT=1 ;; esac
  case "$arg" in --model|-m|--settings|--name|--permission-mode|--max-turns|--max-budget-usd|--mcp-config|--allowedTools|--disallowedTools|--append-system-prompt|--system-prompt|--output-format|--input-format|--session|--session-id|--resume|-r|--port|--hostname) EXPECT_VALUE=1; continue ;; esac
  case "$arg" in -*) ;; *) [ -n "$POSITIONAL" ] || POSITIONAL="$arg" ;; esac
done
case "$POSITIONAL" in resume|continue|fork) EXPLICIT=1 ;; esac
if [ "${TG_OPENCODE_NEW:-0}" = 1 ] && [ "$EXPLICIT" = 1 ]; then
  echo 'polydaemon-opencode: new cannot be combined with session/resume/continue/fork selection' >&2
  exit 2
fi
cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="${TG_BRIDGE_REPO:-}"
if [ -z "$REPO" ]; then
  if [ -f ./clients/opencode-launch.ts ]; then
    REPO="$(pwd -P)"
  elif [ -f ./opencode-launch.ts ]; then
    REPO="$(cd .. && pwd -P)"
  elif [ -f "$HOME/.config/polydaemon/repo-path" ]; then
    IFS= read -r REPO < "$HOME/.config/polydaemon/repo-path" || [ -n "$REPO" ]
  fi
fi
if [ -z "$REPO" ] || [ ! -f "$REPO/clients/opencode-launch.ts" ]; then
  echo "polydaemon-opencode: run hooks/install.py --mcp --opencode from the checkout, or set TG_BRIDGE_REPO" >&2
  exit 1
fi
exec bun run "$REPO/clients/opencode-launch.ts" "$@"
