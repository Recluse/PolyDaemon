# PolyDaemon For OpenCode V2

Targets native OpenCode 2.0.22, not V1's plugin hooks. The integration uses
[native V2 plugin APIs](https://opencode.ai/v2/docs/build/plugins): MCP
transforms, session prompt admission, tool/permission hooks and retry notices.

## Local Setup

From any checkout path, with Bun, Python, Node and OpenCode V2 on PATH:

```sh
python3 hooks/install.py --mcp --opencode --dry-run
python3 hooks/install.py --mcp --opencode
```

Use the private `machine.env` from [getting-started.md](getting-started.md).
Neither Claude nor Codex needs to be installed. The installer creates only
`~/.config/opencode/plugins/tg-bridge/{index.ts,tui.tsx,package.json}` and
`~/.config/polydaemon/repo-path`; it refuses to overwrite a foreign loader.
Bridge delivery is inactive outside a launcher-owned private runtime; the
read-only memory-status RPC also works in ordinary local windows. The CLI
entry adds an optional memory-status block to the native sidebar. Existing
provider settings and managed plugins are not replaced. Re-run after moving the
checkout. `--uninstall` removes only this loader and its matching repo locator;
`--dry-run` also works for removal.

The launcher uses `~/.config/polydaemon/machine.env` when present, otherwise
the existing `mcp_servers.tg-bridge.env` in `~/.codex/config.toml`. Credentials
are inherited through the environment, not exposed in argv or repository files.

Copy `clients/polydaemon-opencode.sh` to a project root with mode0755. It starts a
private native server for that folder and passes an explicit root session ID.
It cannot attach a child or foreign-workspace session or a custom remote
server. `TG_OPENCODE_NEW=1` starts fresh without removing history.
The copied launcher discovers the checkout from `repo-path`; `TG_BRIDGE_REPO`
can override it. It has no fixed home-directory or repository-name requirement.

The bot must load the updated `resolve_workspace_id` before production use:
OpenCode gets `<folder>-opencode` and binding `<cwd>#opencode`, separate from
Claude and Codex. Updating local code alone does not update the running bot.
The native MCP catalog displays `PolyDaemon`; legacy `tg-bridge` tool prefixes
remain recognized. Plugin/launcher paths and Telegram binding keys remain stable.

## Delivery And Approvals

Before admitting the first prompt, the plugin waits for enabled MCP connections
and an executable bridge tool catalog. A timeout fails admission rather than
starting the model with an empty catalog. Managed provider/header plugins are
not changed by this gate.

Incoming messages stay in the authenticated SQLite bridge queue until native durable
prompt admission succeeds. Retries use the same message ID; reactions do not
start model turns. The model has the usual MCP reply/inter-window tools; when
it finishes without replying, the plugin mirrors its final text through the
existing topic-aware safety-net endpoint. Model/API retry failures are notified
in Telegram.
OpenCode's MCP `receive` does not drain that queue: only successful prompt
admission followed by an exact-ID HTTP acknowledgment can remove an item.
Pending OpenCode items are not truncated at the legacy 100-message limit.
The pre-admission queue survives bridge process crashes, preserving message IDs,
metadata and FIFO order. It is scoped to the physical project directory and stored
in `~/.tg-bridge-channel/opencode-inbound.db`; successful receipt is reported only
after the queue write commits. Delivery is at least once: a crash between prompt
admission and acknowledgment retries the same native message ID. Unacknowledged
items are not expired automatically. Stdin EOF unregisters the bridge; an orphaned
bridge cannot block a subsequent launcher.

The existing shared guard classifies tool calls. Push/deploy and explicit file
access outside the workspace need a Telegram tap. Native configured denials
remain final. A tool-call ID prevents a second native prompt for the same
one-shot approval; OpenCode approvals never persist Claude allow rules.
Read-only access to the bridge's own files uses the owner's shared-read exception,
including native external-directory permission checks. Explicit native denials
are still final. Claude-only TUI injection and transcript compaction are disabled.
As with the existing guard, command classification is not a sandbox against
indirect shell access inside arbitrary scripts.

Tool progress includes the shell command (not only `shell`) and the path for
file tools, flattened and capped at 200 characters like the shared status
endpoint. Command text is sent to the authorized Telegram chat; avoid placing
credentials directly in command arguments.

## Project Memory Sidebar

The native sidebar shows this session's registered Telegram topic, using its
own bridge's authenticated registration state, not a folder-name guess.
Unbound, unregistered and unavailable bridges have explicit states.

The `HyperMnesia` section refreshes every 60 seconds over location-scoped native RPC,
without a model turn. It discovers a connected local MCP by its `project_status`
capability, with any server name. It opens a short second stdio connection using
that server's existing configuration, calls only the annotated read-only
`project_status({})`, verifies physical root and repo, then closes it. Concurrent
polls are coalesced and cached for 60 seconds. It does not install memory, change
scope/environment, ingest documents, or access SQL directly.
Startup's unavailable/pending catalog is rechecked after five seconds, without
opening a memory process until the native connection/catalog is ready.

Version 1 reports scoped indexed documents/chunks, SHA256 freshness counts
(`Changed`, `New`, `Missing`), map presence and check time. Freshness covers the
backend's indexable Markdown documents, not all source code. `Checked` is the
snapshot time, not the time of a successful full ingest. Map presence does not
prove that its component paths are current. Null, timeout, scope mismatch,
disabled/ambiguous servers and unsupported remote transports never become zero
or fresh. Set HyperMnesia's `HM_ROOT` and `HM_REPO` in its native per-project MCP
configuration when process cwd/basename do not identify the indexed project.

Older servers without `project_status` retain observed `get_project_map` and
connection status; counts/freshness remain unknown. An observed cached map is
not proof of a live database. OpenCode needs its own native V2 MCP configuration;
a Claude `.mcp.json` or a connected Telegram bridge does not install HyperMnesia.
See [companions.md](companions.md#hypermnesia--memory) for optional memory setup.

Re-run the OpenCode installer after updating to install the CLI entry. Existing
windows are not restarted automatically. The panel was rendered in an isolated
OpenCode 2.0.22 TUI; parser and installer checks cover missing/error/warning and
foreign-loader cases. A live memory-result update in a user's window is a
separate acceptance check.

## Checks

- `python3 clients/test_tg_opencode.py`: cwd, new/resumed sessions, argv and exit.
- `bun test clients/opencode-plugin.test.ts`: ownership, retry-before-ack,
  permission denial/deduplication, final mirror and API error notices.
- `bun test clients/opencode-memory.test.ts`: observed map, connection and
  scope/stale warnings without invented health metrics.
- `bun test clients/opencode-memory-reader.test.ts`: real stdio/RPC, root/repo
  checks, null counts, false-fresh rejection, coalescing and cleanup.
- `node hooks/tg-bridge-locate.test.js`: agent/UID isolation.
- `bun test channel-plugin/src/opencode-queue.test.ts`: real MCP/HTTP queue,
  bridge-read consumer isolation, crash recovery, workspace isolation, retained
  backlog and graceful EOF shutdown.
- `bun test channel-plugin/src/codex-identity.test.ts`: distinct agent bindings.
- `PYTHONPATH=tg-bot python3 tg-bot/test_interwindow_topics.py`: bot-side topics.

Native acceptance also requires actual incoming/reply/approval roundtrips and
MTPLX co-load with three real read-only agentmem calls. MCP `connected` alone
does not prove that the model can use those tools. Runtime activation and
launcher distribution remain separate from these code checks.

## Local Acceptance 2026-10-05

Native OpenCode 2.0.22 with isolated fixture Telegram/provider endpoints passed
prompt admission, one reply in its own forum topic, bridge reads without asks,
protected `shell` denial before execution, and a one-shot help-only command
(`git push -h`) with native `shell: ask` and no duplicate approval card.
The native permission observer recorded the matching tool ID and final `allow`.
No source push or deployment was executed by these fixtures.

Infra independently verified the real launcher with MTPLX and three actual
read-only agentmem calls, without a priming read. The first provider snapshot
contained 32 tools, including memory and bridge tools; native HTTP observation
confirmed both MTPLX client/session headers. Exit 0, empty stderr, and the
location's registry entries disappeared after exit.

Production activation must deploy and verify the bot's separate `#opencode`
binding before distributing launchers for regular use. Existing Claude/Codex
windows retain their plugin process until their next normal restart.
