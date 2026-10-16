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
fi
# Parse selectors without mistaking option values or text after -- for flags.
EXPLICIT=0
MANAGEMENT=0
POSITIONAL=""
EXPECT_VALUE=0
for arg in "$@"; do
  if [ "$EXPECT_VALUE" = 1 ]; then EXPECT_VALUE=0; continue; fi
  [ "$arg" != -- ] || break
  case "$arg" in --help|-h|--version|-V) MANAGEMENT=1 ;; esac
  case "$arg" in --session|--session=*|--session-id|--session-id=*|--resume|--resume=*|--continue|--continue=*|--fork|--fork=*|--fork-session|--fork-session=*|-r) EXPLICIT=1 ;; esac
  case "$arg" in -c|--config|-s|--sandbox|-a|--ask-for-approval|-C|--cd|-m|--model|-p|--profile|-i|--image|--remote|--remote-auth-token-env|--local-provider|--enable|--disable|--add-dir) EXPECT_VALUE=1; continue ;; esac
  case "$arg" in -*) ;; *) [ -n "$POSITIONAL" ] || POSITIONAL="$arg" ;; esac
done
case "$POSITIONAL" in resume|continue|fork) EXPLICIT=1 ;; esac
if [ "${TG_CODEX_NEW:-0}" = 1 ] && [ "$EXPLICIT" = 1 ]; then
  echo 'polydaemon-codex: new cannot be combined with session/resume/continue/fork selection' >&2
  exit 2
fi
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$POSITIONAL" in
  agents|mcp|app-server|doctor|login|logout|features|plugin|completion|update|exec|e|review|queue|sandbox|debug|apply|a|app|archive|delete|unarchive|migrate-rollouts|cloud|exec-server|remote-control|help) MANAGEMENT=1 ;;
esac
if [ "$MANAGEMENT" = 1 ]; then exec codex --cd "$(pwd -P)" "$@"; fi
PORT="${TG_CODEX_WS_PORT:-3210}"
WS="ws://127.0.0.1:${PORT}"
if ! curl -sm2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  echo "polydaemon-codex: the daemon's Codex app-server is not answering on :${PORT} — start agent/agentd.ts (docs/codex.md)" >&2
  exit 1
fi
# Resume this folder's most recent thread, if the daemon knows it.
RESUME_ID=""
AGENT_TOML="$HOME/.tg-bridge/agent.toml"
if [ -f "$AGENT_TOML" ] && [ "${TG_CODEX_NEW:-0}" != 1 ] && [ "$EXPLICIT" = 0 ]; then
  TOKEN="$(grep '^auth_token' "$AGENT_TOML" | cut -d'"' -f2)"
  APORT="$(grep '^port' "$AGENT_TOML" | tr -dc '0-9' || true)"
  RESPONSE="$(curl -fsm4 -H "Authorization: Bearer ${TOKEN}" \
    --get --data-urlencode "cwd=$(pwd -P)" \
    "http://127.0.0.1:${APORT:-3200}/v1/codex/last-thread" \
    2>/dev/null)" || { echo 'polydaemon-codex: last-thread lookup failed; refusing to silently start fresh' >&2; exit 1; }
  RESUME_ID="$(printf '%s' "$RESPONSE" | node -e '
    let data=""; process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => { try {
      const value=JSON.parse(data);
      if(!value || !Object.hasOwn(value, "thread_id") || value.ok === false || !(value.thread_id == null || typeof value.thread_id === "string")) throw Error();
      if(value.thread_id && !/^[A-Za-z0-9-]+$/.test(value.thread_id)) throw Error();
      process.stdout.write(value.thread_id || "");
    } catch { console.error("polydaemon-codex: invalid last-thread response"); process.exitCode=1; } });
  ')"
fi
# Opt in for centrally managed installations only; never alter global settings.
UPDATE=""
[ "${TG_CODEX_CHECK_UPDATE:-}" != 0 ] || UPDATE="check_for_update_on_startup=false"
if [ -n "$UPDATE" ]; then set -- -c "$UPDATE" "$@"; fi
launch_codex() {
  # Management/non-interactive calls never allocate a terminal or a sidebar.
  if [ "${TG_CODEX_SIDEBAR:-auto}" != 0 ] && { [ -t 0 ] && [ -t 1 ] || [ "${TG_CODEX_SIDEBAR:-auto}" = 1 ]; }; then
    REPO="${TG_BRIDGE_REPO:-}"
    if [ -z "$REPO" ]; then
      if [ -f ./clients/codex-console.py ]; then REPO="$(pwd -P)"
      elif [ -f ./codex-console.py ]; then REPO="$(cd .. && pwd -P)"
      elif [ -f "$HOME/.config/polydaemon/repo-path" ]; then
        IFS= read -r REPO < "$HOME/.config/polydaemon/repo-path" || [ -n "$REPO" ]
      fi
    fi
    if [ -f "$REPO/clients/codex-console.py" ] && command -v tmux >/dev/null 2>&1 \
        && command -v bun >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 \
        && python3 -c 'import curses' >/dev/null 2>&1; then
      exec python3 "$REPO/clients/codex-console.py" codex "$@"
    fi
    echo 'polydaemon-codex: sidebar needs tmux, Bun, Python curses and a current PolyDaemon checkout' >&2
    [ "${TG_CODEX_SIDEBAR:-auto}" != 1 ] || exit 1
  fi
  exec codex "$@"
}
if [ -n "$RESUME_ID" ]; then
  echo "polydaemon-codex: continuing thread ${RESUME_ID}"
  launch_codex --remote "$WS" resume "$RESUME_ID" --cd "$(pwd -P)" "$@"
else
  launch_codex --remote "$WS" --cd "$(pwd -P)" "$@"
fi
