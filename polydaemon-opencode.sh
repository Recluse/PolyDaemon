#!/usr/bin/env bash
# OpenCode V2 window with the Telegram bridge plugin.
set -euo pipefail
if [ "${1:-}" = new ]; then
  shift
  export TG_OPENCODE_NEW=1
  for arg in "$@"; do
    case "$arg" in
      --session|--session=*|-s|--continue|-c|--fork)
        echo 'polydaemon-opencode: new cannot continue, resume or fork a session' >&2; exit 2 ;;
    esac
  done
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
