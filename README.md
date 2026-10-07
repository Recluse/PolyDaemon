# PolyDaemon

<img src="docs/assets/polydaemon-logo.png" alt="PolyDaemon logo" width="180" height="180">

Drive Claude Code, Codex and OpenCode windows from Telegram. Message a bot, and the message lands
in a specific agent window; the answer, and the work in progress, come back
to the chat. Several windows at once, on one machine or several.

Launchers use `polydaemon-<agent>`. Some integration IDs retain the former
`tg-bridge` name for [backward compatibility](docs/naming.md).

> **Status:** early MIT release, not a polished product. The Claude adapter uses
> Claude Code's channels, which are a research preview
> (`--dangerously-load-development-channels`) and may change.
> [Русская версия](README.ru.md)

## What it does

- **A Claude Code window you can reach from your phone.** Send a message, it goes
  to the window you picked; the reply comes back. The conversation lives in the
  window's own Claude Code session.
- **One topic per window — or one room for all.** In a Telegram forum group each
  window gets its own topic, or every window shares one topic and you address one
  with `@name`.
- **Live progress.** While Claude works, a status message shows the tool calls and
  what the model is thinking out loud.
- **Approvals, questions and plans in Telegram.** Permission prompts,
  `AskUserQuestion` and plan approval arrive as buttons. An approval nobody
  answers never goes through on its own.
- **Start windows from Telegram** with `/launch` — on macOS they open as iTerm2
  tabs, and with several machines each gets its own tab in the picker.
  `/restart all` restarts every idle window, so an update reaches all of them.
- **Several machines, one bot.** Windows on a Mac and a Windows PC report to one
  bot over your own network.
- **Two windows, one file.** A window about to edit a file another window on the
  same machine is editing gets warned first; `/who` shows who is working where.
- **Idle compaction.** A window left idle with a large context is compacted once,
  and left alone if that does not help — until it has had new activity.
- **Files up to 2 GB, both ways.** A window can send you a build, an installer or
  a video — up to 1990 MB each with your own Bot API server, where the cloud API
  stops at 50 MB — and files you send it arrive without a size limit.
  [How](docs/large-files.md).
- **Codex windows** — experimental: [docs/codex.md](docs/codex.md).
- **OpenCode V2 windows** — native session/tool/permission hooks:
  [docs/opencode.md](docs/opencode.md). V1 plugins are not supported.

## How it fits together

```text
You in Telegram
     │  Bot API
     ▼
[telegram-bot-api]   cloud by default, or your own for files up to 2 GB
     │
     ▼  getUpdates
[Router bot]  (Python)            the only thing that reads from Telegram
     │  picks the window, handles /commands, maps topics to windows
     │  HTTP → the chosen window
     ▼
[Channel plugin]  (Bun/TS, one per window) ──MCP channel──► Claude Code
     └──────── sends the reply to Telegram ◄──── reply tool ──┘

[Hooks] approvals · questions · plans · notifications · reply mirror,
        from Claude Code to Telegram — active only in windows with a plugin
```

More in [docs/architecture/system-overview.md](docs/architecture/system-overview.md).

## Getting started

**[docs/getting-started.md](docs/getting-started.md)** — everything on one
machine, step by step: create the bot, configure it, register the plugin, install
the hooks, start a window, send the first message.

You need Bun 1.3.x, Python 3.11+, Node 22.5+, and the agent you choose. Claude
Code is not required for Codex or OpenCode. Start with the shared bot and
machine configuration in the getting-started guide, then follow your agent's
setup. See [platforms.md](docs/platforms.md) for the tested scope and gaps.

For several machines against one bot, see
[docs/multi-machine.md](docs/multi-machine.md).

## What is in the repository

| Folder | What it is |
|---|---|
| `tg-bot/` | The router bot. Owns the bot token, is the only thing polling Telegram, routes to windows, keeps topics and the window registry. Entry point: `tgbridge.py`. |
| `channel-plugin/` | The MCP server loaded into each Claude Code window. Takes messages from the bot, pushes them into Claude, sends replies to Telegram. |
| `hooks/` | The Claude Code hooks, and `install.py` to register them. |
| `clients/` | Window launchers (`polydaemon-claude.sh` for macOS/Linux), the per-machine launch agent, Codex helpers. |
| `polydaemon-claude.cmd`, `launch-ws.ps1` | The Windows launcher, and the script that starts a window from `/launch`. |
| `agent/` | A per-machine daemon for Codex windows and orphan cleanup. |
| `vscode-extension/` | Optional: spawns a Claude terminal and an approval UI in VS Code. |
| `docs/` | Everything else — see below. |

## Documentation

- **[Getting started](docs/getting-started.md)** — one machine, from scratch.
- **[Architecture](docs/architecture/)** — the plugin, the bot, the hooks, the
  protocol between them.
- **[Configuration](docs/reference/configuration.md)** — every setting.
- **[Runbooks](docs/runbooks/)** — diagnosing the usual failures.
- **[Decisions](docs/adr/)** — architecture decisions and why.
- **[Several machines](docs/multi-machine.md)** — one bot, windows anywhere on
  your network.
- **[Windows, macOS, Linux](docs/platforms.md)** — what works where.
- **[Works well with](docs/companions.md)** — HyperMnesia for memory, Serena for code navigation.
- **[Large files](docs/large-files.md)** — up to 2 GB through your own Bot API server.

## Security

This is remote control of a shell. Read this before running it.

The [initial source review](docs/security-audit.md) records the findings fixed
before publication, regression checks and remaining trust boundaries.

- **The bot obeys only `telegram.allowed_users`,** and refuses to start with an
  empty list. Windows run in `bypassPermissions` mode, so anyone on that list can
  make Claude run any command on the machine.
- **Pushes, deployments and explicit file access outside the workspace wait
  for owner approval** through the shared guard. Unanswered approvals do not
  allow execution. This classifier is not a sandbox against indirect operations
  inside arbitrary scripts; native agent restrictions still apply.
- **Secrets stay out of the repository.** `tg-bot/config.yaml` is ignored by git;
  `config.yaml.example` is the template. The plugin gets its token from the
  environment Claude Code starts it with.
- **Every plugin endpoint requires a bearer token.** On one machine the plugins
  listen on loopback only (the default); with several machines each listens on
  the address you give it (`TG_BRIDGE_BIND_HOST`) — use a private network such as
  WireGuard, never a public interface. The multi-machine registry has its own
  enrollment token and accepts only the subnets you list.

## License

[MIT](LICENSE). The public repository is a standalone source distribution, not
a deployment or a copy of a user's machine configuration. Optional memory:
[HyperMnesia](docs/companions.md#hypermnesia--memory).
