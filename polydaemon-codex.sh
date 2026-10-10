#!/usr/bin/env bash
# polydaemon-codex.sh — a Codex window attached to the daemon's shared app-server.
# Telegram messages reach it by push (the daemon starts a turn in the thread),
# the TUI and the bridge see the same thread, and the window registers as
# "<folder>-codex" with its OWN forum topic. It continues this folder's last
# thread when the daemon knows one. See docs/codex.md.
set -euo pipefail
if [ "${1:-}" = new ]; then
  shift
  export TG_CODEX_NEW=1
  case "${1:-}" in
    resume|fork) echo 'polydaemon-codex: new cannot resume or fork a session' >&2; exit 2 ;;
  esac
fi
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${TG_CODEX_WS_PORT:-3210}"
WS="ws://127.0.0.1:${PORT}"
if ! curl -sm2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "polydaemon-codex: the daemon's Codex app-server is not answering on :${PORT} — start agent/agentd.ts (docs/codex.md)" >&2
  exit 1
fi
# Resume this folder's most recent thread, if the daemon knows it.
RESUME_ID=""
AGENT_TOML="$HOME/.tg-bridge/agent.toml"
if [ -f "$AGENT_TOML" ] && [ "${TG_CODEX_NEW:-0}" != 1 ]; then
  TOKEN="$(grep '^auth_token' "$AGENT_TOML" | cut -d'"' -f2)"
  APORT="$(grep '^port' "$AGENT_TOML" | tr -dc '0-9')"
  RESUME_ID="$(curl -sm4 -H "Authorization: Bearer ${TOKEN}" \
    --get --data-urlencode "cwd=$(pwd -P)" \
    "http://127.0.0.1:${APORT:-3200}/v1/codex/last-thread" \
    2>/dev/null | sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p')"
fi
if [ -n "$RESUME_ID" ]; then
  echo "polydaemon-codex: continuing thread ${RESUME_ID}"
  exec codex --remote "$WS" resume "$RESUME_ID" --cd "$(pwd -P)" "$@"
else
  exec codex --remote "$WS" --cd "$(pwd -P)" "$@"
fi
