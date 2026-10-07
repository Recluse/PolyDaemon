# clients/

PolyDaemon clients for machines running Claude Code, Codex or OpenCode.
See [launcher names and compatibility](../docs/naming.md).

| File | What it is |
|---|---|
| `polydaemon-claude.sh` | The window launcher for macOS and Linux. Put it in a project's root (copy or symlink) and run it there: it starts Claude with the Telegram channel, names the window after the folder, resumes the last conversation and runs in `bypassPermissions`. Windows uses `polydaemon-claude.cmd` from the repository root. |
| `launch-agent.ts` | The per-machine launch agent: a small always-on HTTP server the bot calls for `/launch` and `/restart`. Windows and macOS. |
| `launch-ws.sh` | What the launch agent runs on macOS: opens a project as an iTerm2 tab (or a Terminal.app window) and answers Claude's startup prompts. By hand: `launch-ws.sh <name> [folder]`, `-l` to list, `--check` for a self-test that opens nothing. Windows has `launch-ws.ps1` in the repository root. |
| `polydaemon-codex.sh`, `polydaemon-codex.ps1` | Codex window launchers for macOS/Linux and Windows. PowerShell takes `-Workspace <path>`; keep it beside `start-agentd.ps1`. |
| `codex-mcp.sh` | Internal MCP transport helper, not a window launcher. |
| `polydaemon-opencode.sh` | OpenCode V2 launcher for macOS/Linux, backed by `opencode-launch.ts` and the native `opencode-plugin.ts`. Requires the plugin loader and an updated bot for separate `-opencode` topics. |

Setting them up: [getting-started](../docs/getting-started.md) for one machine,
[multi-machine](../docs/multi-machine.md) for the launch agent and several
machines, [platforms](../docs/platforms.md) for what works where.

`polydaemon-claude.sh` turns Claude's own auto-compact off for the window, so a large
resumed conversation is not compacted the moment it loads;
`TG_KEEP_AUTOCOMPACT=1` leaves it on. It and `launch-ws.sh` run on macOS's stock
bash 3.2.

Run `./polydaemon-opencode.sh` in the project root. It resumes the last root session
for that physical folder; `TG_OPENCODE_NEW=1` starts a new one. It uses a native
private server (`--standalone`) and refuses another active bridge window for
the same workspace. `TG_BRIDGE_REPO` overrides the bridge checkout path.
Providers and the existing OpenCode service are left untouched. Check the
launcher without model calls with `python3 clients/test_tg_opencode.py`.
See [OpenCode setup and verification](../docs/opencode.md).
