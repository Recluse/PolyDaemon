# Windows, macOS, Linux — what works where

## Agent scope for the first release

| Adapter | Connection | Verified here | Still needs native acceptance |
|---|---|---|---|
| Claude Code | MCP development channel and hooks | Existing integration and isolated hook tests | Fresh-install end-to-end check for each platform |
| Codex | Per-machine app-server and remote TUI | macOS delivery; isolated daemon, identity and launcher tests | Windows PowerShell 7/npm launcher `-Check` and full Telegram roundtrip; Linux roundtrip |
| OpenCode V2 | Launcher-owned standalone server and native V2 hooks | macOS 2.0.22 inbound/reply/approval fixtures and optional memory co-load | Linux/Windows native roundtrip; generic provider acceptance |

Bot launch/restart, model changes and compaction are not yet uniform across
agents. Do not apply the Claude terminal-control table below to Codex or
OpenCode. OpenCode's pre-admission queue is SQLite-backed and survives bridge
process crashes; native message IDs remain stable until acknowledgment. Memory
is optional; see [companions.md](companions.md).

## Claude terminal control

The core runs everywhere: messages in and out, progress, approvals, questions,
plans, files, topics. What differs is how far the bot can reach **into** a
window's terminal: starting a window, and typing a Claude Code command into one.

| | Windows | macOS + iTerm2 | macOS, in tmux | macOS, Terminal.app | Linux (tmux) |
|---|---|---|---|---|---|
| Router bot | ✓ | ✓ | ✓ | ✓ | ✓ |
| Messages, replies, progress | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approvals, questions, plans (hooks) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Files both ways | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/launch` — start a window | ✓ | ✓ as a tab | ✓ detached session | ✓ as a window, startup prompts answered by you | ✓ detached session |
| Commands typed into a window: `/compact`, `/model`, `/effort`, `/exit` | ✓ | ✓ | ✓ | — | ✓ |
| `/restart`, `/restart all`, `/restart stale` | ✓ | ✓ | ✓ | — | ✓ |
| Idle compaction | ✓ | ✓ | ✓ | — | ✓ |

**Why the gaps.** A message from Telegram reaches Claude as an ordinary prompt,
never as a slash command, so running `/compact` in a live window means typing it
into that window's terminal. On Windows the plugin attaches to the window's
console and writes keystrokes (`inject-keys.ps1`); on macOS it drives iTerm2
through AppleScript; anywhere, a window running inside **tmux** is typed into
with `tmux send-keys` on its own pane. A window in a plain terminal — Terminal.app,
or any Linux terminal without tmux — has no such interface, and the bot says so
plainly rather than failing silently.

`/restart` needs both halves — it closes a window by typing `/exit`, then starts
it again — so it goes wherever both work.

## Windows

- **Launchers:** `polydaemon-{claude,codex,opencode,mimo}.cmd` from the repository
  root, copied into each project. They require PowerShell 7 and a configured
  checkout path. `new` starts a fresh session; normal launches retain each
  adapter's resume behavior. See [Windows launchers](windows-new-sessions.md).
- **`/launch`:** `launch-ws.ps1`, run by the launch agent. It opens a console,
  selects the requested agent and session mode, answers only Claude's startup
  prompts by reading the screen, and minimises it
  (under Windows Terminal, which owns its windows, the minimise has no effect).
- **Python** may be `py` or `python` rather than `python3`:
  `py hooks\install.py`.
- **Docker for your own Bot API server** usually lives inside WSL; the plugin's
  default docker command on Windows is `wsl docker` (`TG_BOTAPI_DOCKER`).

## macOS

- **Launcher:** `clients/polydaemon-claude.sh`, linked or copied into each project. It
  works with the stock bash 3.2.
- **iTerm2 is recommended.** With it, `/launch` opens windows as tabs, answers the
  startup prompts, and the bot can type commands into a window. The first time,
  macOS asks whether the app running the script — the launch agent, or your
  terminal — may control iTerm2; approve it once.
- **Terminal.app** works for everything except typing into a window: `/launch`
  opens a window, and you answer the startup prompts in it.
- **tmux instead** (`brew install tmux`): `TG_TMUX=1` for `clients/polydaemon-claude.sh`,
  `TG_MAC_TERMINAL=tmux` for the launch agent — then it behaves as on Linux.
- The launch agent runs as a LaunchAgent — see
  [multi-machine.md](multi-machine.md#3-starting-windows-from-telegram--the-launch-agent).

## Linux

- **Install tmux.** With it, everything in the table works: `clients/polydaemon-claude.sh`
  starts the window inside a tmux session named `pd-<folder>` (reattach any time
  with `tmux attach -t pd-<folder>`), the bot types commands into that pane, and
  `/launch` starts a detached session and answers Claude's startup prompts by
  reading the pane. `TG_TMUX=0` turns it off.
- **Without tmux:** messages, approvals, questions, plans and files still work,
  but nothing can be typed into a window and a launch agent refuses `/launch`,
  saying why.
- The bot itself is at home here: a Linux server is a natural bot host for
  windows on other machines.

## Everywhere

- **Updates reach a window only when it restarts.** A running window keeps the
  plugin and settings it started with. After `git pull`, use `/restart` (or
  `/restart all`) where it is available, and close and reopen the window where it
  is not.
- The hooks are Node scripts and the plugin is a Bun program, identical on all
  three.
