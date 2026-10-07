# agent/ — PolyDaemon agent daemon (agentd) v0

Per-machine daemon: runs Codex windows (the Codex app-server behind
`clients/polydaemon-codex.sh`) and is the local backend for a desktop board that is still
in the works. Watches the
plugins' local registry (`~/.tg-bridge-channel/instances.json`), tails Claude
Code JSONL transcripts, detects orphaned channel-plugin processes and stale
registry rows, forwards messages into windows, and launches new windows
(macOS/Terminal.app in v0).

Works alongside the bridge without modifying it — read-only over the registry
and transcripts; writes only via the plugins' existing `/message` endpoint.

## Run

```sh
bun run agent/agentd.ts
```

First run creates `~/.tg-bridge/agent.toml` with defaults and logs a warning:

```toml
machine_id = "hostname"     # this machine's id for the board
bind_host = "127.0.0.1"     # or the mesh IP; NEVER 0.0.0.0
port = 3200
auth_token = "<generated>"  # Bearer for every endpoint except /v1/health
board_pubkey = ""           # reserved (signed board commands, later phase)
```

Debug logging: `TG_AGENTD_DEBUG=1` (transcript-parser skips, tail internals).

## Endpoints

All except `/v1/health` require `Authorization: Bearer <auth_token>`.

| Endpoint | What |
|---|---|
| `GET /v1/health` | no auth — `{ok, version}` |
| `GET /v1/status` | `{machine_id, version, windows[], orphans[], stale[]}` — windows from instances.json; orphans = channel-plugin processes with PPID=1 or a dead parent (FR-401); stale = rows failing the `_row_is_stale` port (heartbeat > 45s, pid dead/reused) |
| `WS /v1/events` | live tail of every live window's newest transcript, normalized events `{window_key, ts, kind: message\|thought\|tool_call\|tool_result\|other, role?, text?, tool?, detail?}`, one JSON object per frame (ndjson-compatible). Auth: Bearer header or `?token=` |
| `GET /v1/windows/{key}/transcript?since=&limit=` | history pages from the same JSONL. `key` = instance_name; `since` = ISO-8601 or unix epoch; `limit` ≤ 1000 (default 100). Returns `next_since` for the following page |
| `POST /v1/send` | `{window_key, text}` → the window plugin's `POST /message` (Bearer from the registry row), sender marked `chat_id/user_id = 'board'` |
| `POST /v1/launch` | `{workspace_path, name?}` → opens Terminal.app running the workspace's `polydaemon-claude.sh` if present, else the inline equivalent (`claude --dangerously-load-development-channels server:tg-bridge --continue --permission-mode bypassPermissions` with `TG_BRIDGE_INSTANCE_NAME` exported). macOS only in v0 |

Quick smoke:

```sh
TOKEN=$(grep auth_token ~/.tg-bridge/agent.toml | cut -d'"' -f2)
curl -s localhost:3200/v1/health
curl -s -H "Authorization: Bearer $TOKEN" localhost:3200/v1/status | jq .
curl -sN "ws://..."   # or: bunx wscat -c "ws://127.0.0.1:3200/v1/events?token=$TOKEN"
```

## Autostart (launchd, macOS)

Copy [`launchd/com.tg-bridge.agentd.plist`](launchd/com.tg-bridge.agentd.plist)
to `~/Library/LaunchAgents/`, adjust the bun and repo paths, then:

```sh
launchctl load ~/Library/LaunchAgents/com.tg-bridge.agentd.plist
tail -f /tmp/tg-bridge-agentd.log
```

`KeepAlive` restarts it on crash; `launchctl unload …` stops it.

## v0 limitations / TODO

- Transcript sources: Claude Code JSONL only (Codex driver — SRS 70 — later).
- `/v1/launch`: macOS/Terminal.app branch only; Windows stays on
  `clients/launch-agent.ts`, Linux/systemd later.
- `board_pubkey` unused: no signed commands yet, so no `/v1/kill`,
  `/v1/preset/apply` (SRS 95 lists them for later phases).
- Transcript history reads the newest session file in full per request — fine
  for v0 page sizes, needs an offset index for very large sessions.
- Windows registry source (`bot.db`) not read — instances.json only.
