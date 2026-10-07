# Docs

Start with the [README](../README.md) and [getting-started.md](getting-started.md).

**Setting up**
- [getting-started.md](getting-started.md) — one machine, from scratch.
- [multi-machine.md](multi-machine.md) — one bot, windows on several machines; the launch agent.
- [platforms.md](platforms.md) — what works on Windows, macOS and Linux.
- [codex.md](codex.md) — Codex windows, experimental.
- [companions.md](companions.md) — HyperMnesia (memory) and Serena (code navigation), optional.
- [large-files.md](large-files.md) — files up to 2 GB through your own Bot API server.
- [reference/configuration.md](reference/configuration.md) — every setting: `config.yaml`, the plugin's environment, MCP scopes, permission overrides, state files.

**How it works**
- [architecture/system-overview.md](architecture/system-overview.md) — the whole picture.
- [architecture/channel-plugin.md](architecture/channel-plugin.md) — the MCP plugin, one per window.
- [architecture/telegram-bot.md](architecture/telegram-bot.md) — the router bot.
- [architecture/hooks.md](architecture/hooks.md) — approvals, questions, plans, notifications, the reply mirror.
- [architecture/http-mcp-protocol.md](architecture/http-mcp-protocol.md) — the HTTP contract between bot and plugin, and the MCP channel.
- [architecture/vscode-extension.md](architecture/vscode-extension.md) — the optional VS Code extension.
- [architecture/websocket-protocol.md](architecture/websocket-protocol.md) — historical: WebSocket was replaced by HTTP + MCP.

**Decisions and requirements**
- [adr/](adr/) — architecture decisions and why.
- [requirements/](requirements/) — functional and non-functional requirements.

**When something breaks**
- [runbooks/](runbooks/) — orphaned plugins, messages going to the wrong window, a hung WMI on Windows.

Some of the older documents are in Russian.
