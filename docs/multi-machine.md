# Several machines, one bot

One bot, and Claude Code windows on any number of machines — a Mac, a Windows PC,
a Linux box — all reachable from the same Telegram chat. Start from
[getting-started.md](getting-started.md): get one machine working first, then
spread out.

```text
                 ┌──────────── bot host ────────────┐
Telegram ◄─────► │ router bot · registry :8090      │
                 └──────▲──────────────────┬────────┘
     register/heartbeat │                  │ message → window
                        │                  ▼
     ┌──── machine A ───┴──────┐   ┌──── machine B ──────────┐
     │ plugin per window :3100+│   │ plugin per window :3100+│
     │ launch agent :8091      │   │ launch agent :8091      │
     └─────────────────────────┘   └─────────────────────────┘
```

On one machine the plugins find the bot through a shared database on disk. Across
machines they can't, so the bot runs a small **registry** over HTTP: each plugin
registers there, says which address it listens on, and the bot dials it back.

## Before you start: the network

Every machine must reach the bot host, and the bot host must reach every machine
back — both directions, by IP. A private network is the assumption: a LAN, or a
VPN such as WireGuard or Tailscale between machines that are not on one LAN.
**Never put the registry, the plugins or a launch agent on a public interface.**
Every endpoint wants a bearer token, but the network is meant to be the first
line of defence, not the only one.

The examples below use documentation addresses: the bot host is `198.51.100.2`,
the window machines live in `192.0.2.0/24`. Substitute your own.

## 1. The bot host

Any always-on machine: one of your window machines, or a small server. The bot
itself is the same as in getting-started; only its config grows.

Generate one shared secret. It authenticates plugins to the registry **and** the
bot to the plugins and launch agents:

```sh
openssl rand -hex 32
```

In `tg-bot/config.yaml`:

```yaml
bot:
  registry_bind_host: "198.51.100.2"   # the host's private address; "0.0.0.0" in a container
  registry_port: 8090
  registry_enroll_token: "<the shared secret>"
  mesh_subnet:                         # the subnets your plugins advertise from
    - "192.0.2.0/24"
  registry_verify_source_ip: true      # false when behind NAT, e.g. a Docker-published port
```

The registry refuses to start on a non-loopback address with an empty or short
token. `mesh_subnet` is an allowlist: a plugin advertising an address outside it
is dropped. `registry_verify_source_ip` checks that a plugin registers from the
address it advertises; NAT rewrites the source, so turn it off there — the token
and the subnet list still gate it.

**Running it in Docker.** `tg-bot/Dockerfile` builds the image (context
`tg-bot/`). Mount the config at `/app/config.yaml` and a volume at `/data`, and
publish the registry port:

```yaml
services:
  tg-bridge-bot:
    build: ./tg-bot
    container_name: tg-bridge-bot     # the commands below refer to it by this name
    restart: unless-stopped
    ports: ["198.51.100.2:8090:8090"]
    volumes:
      - tg-bridge-state:/data
      - ./tg-bot/config.yaml:/app/config.yaml:ro
volumes:
  tg-bridge-state: {}
```

The state lives at `/data/.tg-copilot-bridge/bot.db` — one level *below* the
volume root, because it is kept under `$HOME` and `$HOME` is `/data` in the image.

Only **one** bot may poll a given bot token. If one is still running elsewhere —
say, from getting-started — stop it first, or both get `409 Conflict`.

## 2. Each window machine

### The plugin

Set up `~/.config/polydaemon/machine.env` as in getting-started, with the
networking lines filled in, then `python3 hooks/install.py --mcp`:

| Variable | Value |
|---|---|
| `TG_BOT_TOKEN` | the bot token, as before |
| `TG_BRIDGE_AUTH_TOKEN` | **the shared secret** — the same as `registry_enroll_token` |
| `TG_BRIDGE_BOT_URL` | `http://198.51.100.2:8090` — switches the plugin to the HTTP registry |
| `TG_BRIDGE_BIND_HOST` | this machine's private address, e.g. `192.0.2.10` |
| `TG_BRIDGE_ADVERTISE_HOST` | only if the bot must dial a different address than the bind one |
| `TG_API_ROOT` | only with your own Bot API server — see [large-files.md](large-files.md) |

Each window's plugin listens on the first free port from 3100 up. Allow those
ports in from the bot host — on Windows, for example:

```powershell
New-NetFirewallRule -DisplayName "PolyDaemon plugins" -Direction Inbound -Protocol TCP `
  -LocalPort 3100-3149 -RemoteAddress 198.51.100.2 -Action Allow
```

### The hooks

Install them on every machine, as in getting-started:
`python3 hooks/install.py`. They find their window's plugin through a file the
plugin writes locally, so they need nothing from the bot host.

### The launchers

Put the `polydaemon-<agent>.sh` (macOS, Linux) or `polydaemon-<agent>.cmd` (Windows)
launchers in each project, for the agents installed on that machine. Windows
uses PowerShell 7; see [Windows launchers](windows-new-sessions.md).
A window started this way registers with the bot within a
few seconds and shows up in `/window`.

## 3. Starting windows from Telegram — the launch agent

`/launch` selects a machine, a coding agent (**Claude, Codex, OpenCode, MiMo**),
and **Continue** or **New session**, then a project. The project list comes from
known topic registrations; different agents' topics for one folder appear once.
A live Codex window hides only Codex for that folder, not the other agents.
New session passes `new` to the canonical launcher and preserves previous history.
Restart preserves the window's coding agent and normal resume behavior.

Each machine runs a tiny always-on **launch agent**
(`clients/launch-agent.ts`) that the bot calls. It opens the project's folder in
a terminal and answers Claude's startup prompts (on macOS, only in iTerm2;
in Terminal.app you answer them yourself). Other agents receive no simulated
startup keystrokes. Explicit folders never fall back to a different workspace
when a launcher is missing. Update the bot and launch agents together: the bot
refuses agent/new-session selection on older agents that would ignore it.

It is available on **Windows**, **macOS**, and **Linux with tmux** (the window
starts in a detached tmux session) — see [platforms.md](platforms.md).

### Tell the bot which machine owns which folders

```yaml
bot:
  launch_agents:
    - label: "Mac"
      url: "http://192.0.2.10:8091"
      prefixes: ['/Users/me/code']
    - label: "Windows"
      url: "http://192.0.2.11:8091"
      prefixes: ['C:\projects']
```

`/launch` then shows one tab per `label`. `prefixes` are the folders each machine
owns: a window is started — or restarted — on the machine whose prefix contains
its folder. Two machines can each hold a project of the same name; the folder is
what tells them apart. With several agents, a window whose folder no prefix owns
cannot be launched, and the bot says so rather than guess.

### Run the agent on each machine

It needs three variables:

| Variable | Value |
|---|---|
| `TG_BRIDGE_AUTH_TOKEN` | the shared secret |
| `TG_LAUNCH_AGENT_BIND` | this machine's private address — never `0.0.0.0` |
| `TG_LAUNCH_AGENT_PORT` | `8091` |

**macOS** — a LaunchAgent, `~/Library/LaunchAgents/polydaemon.launch-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>polydaemon.launch-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>/absolute/path/to/this/repo/clients/launch-agent.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>TG_BRIDGE_AUTH_TOKEN</key><string>the shared secret</string>
    <key>TG_LAUNCH_AGENT_BIND</key><string>192.0.2.10</string>
    <key>TG_LAUNCH_AGENT_PORT</key><string>8091</string>
    <!-- launchd restarts it (KeepAlive), so it may exit to reload after an update -->
    <key>TG_LAUNCH_AGENT_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/polydaemon-launch-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/polydaemon-launch-agent.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/polydaemon.launch-agent.plist
```

`PATH` must include wherever `bun` and `claude` are installed. Windows open as
iTerm2 tabs when iTerm2 is installed, Terminal.app windows otherwise
(`TG_MAC_TERMINAL=iterm|terminal|auto`). The first launch asks macOS for
permission to control iTerm2 — approve it once.

**Windows** — a wrapper `launch-agent.cmd`, started at logon by Task Scheduler.
It must run in your interactive session, because it opens console windows:

```bat
@echo off
set TG_BRIDGE_AUTH_TOKEN=the shared secret
set TG_LAUNCH_AGENT_BIND=192.0.2.11
set TG_LAUNCH_AGENT_PORT=8091
rem The loop restarts it, so it may exit to reload after an update. (ping, not
rem timeout: timeout refuses to run without a console, and the loop would spin.)
set TG_LAUNCH_AGENT_SUPERVISED=1
:loop
bun run C:\path\to\this\repo\clients\launch-agent.ts
ping -n 4 127.0.0.1 >nul
goto loop
```

```powershell
schtasks /Create /TN "PolyDaemon launch agent" /SC ONLOGON /TR "C:\path\to\launch-agent.cmd"
```

**Linux** — a systemd user service, `~/.config/systemd/user/polydaemon-launch-agent.service`:

```ini
[Unit]
Description=PolyDaemon launch agent

[Service]
Environment=TG_BRIDGE_AUTH_TOKEN=the shared secret
Environment=TG_LAUNCH_AGENT_BIND=192.0.2.12
Environment=TG_LAUNCH_AGENT_PORT=8091
Environment=TG_LAUNCH_AGENT_SUPERVISED=1
ExecStart=%h/.bun/bin/bun run /absolute/path/to/this/repo/clients/launch-agent.ts
Restart=always
# The windows /launch starts live in a tmux server this service starts, which
# sits in the service's control group. The default KillMode would take that
# server — and every window in it — down whenever the agent restarts itself.
KillMode=process

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now polydaemon-launch-agent
loginctl enable-linger "$USER"   # keep it running while you are logged out
```

It needs tmux installed; without it the agent refuses `/launch` and says why.

Allow port 8091 in from the bot host the same way as the plugin ports.

Check an agent from the bot host: `curl http://192.0.2.10:8091/health` answers
`{"ok":true}`. If the bot runs in a container, check from **inside** it — that is
where the request actually leaves from:

```sh
docker exec tg-bridge-bot python -c \
  "import urllib.request;print(urllib.request.urlopen('http://192.0.2.10:8091/health',timeout=6).read())"
```

(Python, not curl: the image has no curl, and a missing curl prints nothing — it
looks exactly like an unreachable agent.)

## Applying updates: /restart

A window loads the plugin, the hooks' settings and Claude Code itself when it
starts; a running window keeps the old ones.

`/versions` shows where an update has and has not landed: each machine's
checkout (commit, branch, local edits), whether its registered hooks are the
ones that checkout installs, and which windows still run older code.

Under it, a button per machine that is behind: **⬆️ Update**. The machine's
launch agent then fetches, checks that the commit the bot names is already in
its own upstream (so the bot can choose a published commit, never supply code),
fast-forwards — refusing, in git's own words, if local commits or edits are in
the way — re-registers the hooks, and restarts itself if it runs under a
supervisor (`TG_LAUNCH_AGENT_SUPERVISED=1`, set in both examples above). The
secrets in `machine.env` stay where they are.

Without the button — after a `git pull` by hand (and
`python3 hooks/install.py` if `/versions` says the hooks are stale):

- `/restart` closes a window — the one bound to the topic you send it in, or
  the active one — and starts it again on its own machine, resuming the same
  conversation.
- `/restart all` does it for every window that is idle, and lists the busy ones
  it skipped — run it again once they finish.

Both need the launch agent on that machine and the ability to type into the
window, so they work on Windows, on macOS with iTerm2, and in tmux on macOS or
Linux — see [platforms.md](platforms.md).

A launch agent is itself a long-running process: restart it after an update
(`launchctl kickstart -k gui/$(id -u)/polydaemon.launch-agent` on macOS; end and
re-run the scheduled task on Windows).

## Operating the bot host

**A config change needs `docker compose restart`, not `up -d`.** `up -d` compares
the container's definition, and an edited bind-mounted file is not part of it: it
prints `Running` and changes nothing, while the bot keeps the config it read at
startup. Check that it really restarted:

```sh
docker inspect -f '{{.State.StartedAt}}' tg-bridge-bot     # should be just now
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://198.51.100.2:8090/heartbeat -d '{}'  # 401 = alive
```

**Removing a window's forum topic.** A topic is bound in two places: the
`window_topics` table and `topic-bindings.json` next to it.

1. Stop the window, then wait about two minutes for the bot to drop it. Until
   then it still counts the window as live and recreates a deleted topic.
2. Check whether the thread is shared: the same project on two machines can bind
   two folders to one thread. If another `window_topics` row points at the same
   `message_thread_id`, remove only this row and keep the topic — deleting it
   would delete the other window's history too, and that cannot be undone.
3. Back up the database (`sqlite3 bot.db ".backup bot.db.bak"`), then delete the
   topic in Telegram, then the row, then the entry in `topic-bindings.json`.
