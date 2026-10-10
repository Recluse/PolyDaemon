#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = new ]; then
  shift
  export TG_MIMO_NEW=1
  for arg in "$@"; do
    case "$arg" in
      --session|--session=*|-s) echo 'polydaemon-mimo: new cannot select an existing session' >&2; exit 2 ;;
    esac
  done
fi
cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="${TG_BRIDGE_REPO:-}"
if [ -z "$REPO" ]; then
  if [ -f ./clients/mimo-launch.ts ]; then
    REPO="$(pwd -P)"
  elif [ -f ./mimo-launch.ts ]; then
    REPO="$(cd .. && pwd -P)"
  elif [ -f "$HOME/.config/polydaemon/repo-path" ]; then
    IFS= read -r REPO < "$HOME/.config/polydaemon/repo-path" || [ -n "$REPO" ]
  fi
fi
if [ -z "$REPO" ] || [ ! -f "$REPO/clients/mimo-launch.ts" ]; then
  echo "polydaemon-mimo: set TG_BRIDGE_REPO to the PolyDaemon checkout" >&2
  exit 1
fi
exec bun run "$REPO/clients/mimo-launch.ts" "$@"
