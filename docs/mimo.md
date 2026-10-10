# MiMo Code

The experimental MiMo adapter uses MiMo Code's server hooks and TUI sidebar
slots, not OpenCode V2 plugins. Native acceptance targets MiMo Code 0.1.15.

Install the existing PolyDaemon bridge dependencies and configure its machine
credentials as described in the main setup guide. Copy
`clients/polydaemon-mimo.sh` into the project, make it executable, and set
`TG_BRIDGE_REPO` to this checkout if no PolyDaemon repo-path is installed.
The launcher finds `mimo` in PATH or `~/.mimocode/bin/mimo`; `MIMO_BIN` overrides it.

```sh
./polydaemon-mimo.sh
```

Each launch owns an authenticated loopback MiMo server and attaches the TUI to
one root session in the physical launch directory. The latest root session
is resumed; `./polydaemon-mimo.sh new` (or `TG_MIMO_NEW=1`) creates a new one and `--session ID`
selects an existing root session in that directory. Changing the directory,
server or session through launcher arguments is intentionally unsupported.
Closing the launcher stops its own processes, not other MiMo windows.

The launcher registers the bridge only as `PolyDaemon`. A native disabled
`tg-bridge` entry prevents MiMo's Claude compatibility importer from starting
the same bridge again from `~/.claude.json`; other Claude MCP imports remain
available. Claude's configuration itself is not modified.

Telegram registration is `<project>-mimo`, with a separate `#mimo` topic key
and durable transport buffer. **Upgrade the router bot together with this client**:
an older bot does not recognize MiMo's topic suffix. This is not an alias for
an OpenCode or Claude window. Inputs use native `prompt_async` even while the
model is generating or awaiting permission. Entries are acknowledged as soon
as their receipt is persisted in MiMo, without waiting for an answer. Native
MiMo owns steering/scheduling; this does not interrupt a running tool or approve
a pending request. A lost connection retains unconfirmed input.
MiMo generates chronological message IDs; a stable text-part ID records queue
admission for retries. Delivery warnings use native TUI notifications, not
background terminal output over the prompt editor. Reply delivery is independent:
receipt metadata in native history records pending/delivered output across
restarts. Telegram failures never hold up new input; incomplete native turns
are never automatically replayed.

Telegram uses the last main-session model only while its provider is connected
and the model remains in that provider's catalog. Otherwise it uses this
window's startup snapshot of the persisted TUI preference, then the configured
model. With no available choice, the message stays queued. The plugin API does
not expose an unsent dropdown selection: sending a console prompt records that
selection in the session for subsequent Telegram turns. Other windows' later
global preference changes are not imported into this running launcher.

The native MCP reply tool is the primary delivery path. If a Telegram turn
finishes with plain text and no confirmed reply tool result, the launcher
mirrors that final text. Tool approvals go through the existing bridge guard;
an unavailable guard or non-allow result cancels execution. Native MiMo asks
are forwarded as one-shot approvals, never persistent allow rules.
Transport failures and expired bridge requests are errors, not denial decisions.
The adapter reports them without replying `reject` to a pending native ask;
that ask remains available in the console. A lost acknowledgement of an allow
also never causes a compensating reject. No command is authorized by an error.

Native file reads/writes and glob/grep in `~/.local/share/mimocode/` do not
require an additional PolyDaemon approval for MiMo in any workspace (logs,
session, project and global memory). MiMo's own memory scope,
agent ownership and write-disable gates still apply. This exception does not
cover shell commands, deletion patches, files outside the data tree or symlink
escapes. No project-specific permission entry is needed.

Telegram inbox reads also need MiMo's native `external_directory` and `read`
permission for the inbox subtree. An `edit: deny` rule for that same subtree
keeps direct writes disabled. The download MCP tool still owns attachment writes.

Aborted native turns may contain `MessageAbortedError` without `time.completed`.
The reply relay treats that error as terminal and reports it. Neither errors
nor unfinished turns block new input. An idle turn with no final answer is
reported as stopped; native grouping/steering of earlier messages does not
produce a separate reply for each input.

## Sidebar and optional memory

PolyDaemon shows the actual registered Telegram topic. HyperMnesia shows its
native MCP connection and scoped `project_status` data: repository, indexed
documents/chunks, freshness, changed/new/missing documents, map and check time.
Unavailable data stays unknown rather than becoming zero or fresh. Polls are
serial and refresh at most once per minute after a successful check.

Existing native MiMo `HyperMnesia`/`agentmem` configuration wins. When absent,
the launcher can reuse the configured local HyperMnesia descriptor from
OpenCode's global `mcp.servers.HyperMnesia`, only with default project cwd.
It does not copy provider settings or permission profiles. The imported
memory-write and supersede tools are denied. Runtime overlays do not rewrite
global configuration. No memory server is installed implicitly.

## Native language servers

MiMo's LSP is separate from MCP and HyperMnesia. Enable it explicitly in the
project's `mimocode.json` with `"lsp": true`, or an object of server overrides.
Built-in servers start lazily for matching files. An override must provide
`command`; an empty per-server object does not enable a built-in server.
Preserve existing model, MCP and permission settings when merging this field.

In MiMo 0.1.15 the sidebar checks `lsp === false`, while the backend checks
`!lsp`. With the setting absent, "LSPs will activate as files are read" therefore
does not prove LSP is enabled. Verify the effective configuration and an actual
native server connection, not just this label:

```sh
mimo --pure debug lsp diagnostics /absolute/path/to/source.py
```

Language servers must be installed or available through MiMo's native downloads.
Umbrella projects may need a TypeScript command/tsserver path override because
the built-in launcher resolves TypeScript from the window's root. Kotlin can use
an installed `kotlin-lsp --stdio` command under the built-in `kotlin-ls` ID.
Do not treat Qt translation `.ts` files as TypeScript. C/C++ and native mobile
semantics still depend on the project's build configuration and dependencies.
Local machine paths belong in local project settings, not public examples.

Already running windows may retain the old LSP instance; relaunch that window
after finishing its current work. No model turn is needed for a native LSP check.

## Checks

```sh
bun test clients/mimo.test.ts channel-plugin/src/opencode-queue.test.ts
MIMO_BIN=/path/to/mimo bun clients/mimo-native-smoke.ts --tui
MIMO_BIN=/path/to/patched/mimo bun clients/mimo-native-smoke.ts --compaction
```

The optional native check uses its own temporary HOME, a local fake provider
and a fixture MCP server. It does not call a paid model or live Telegram.
The `--tui` check requires Python with `pyte`; `PYTHON_BIN` selects that interpreter.
Production bot deployment and a real Telegram round trip remain separate
acceptance steps.

The optional `--compaction` regression expects `tool_choice=none` on the actual
summary request. Installed MiMo 0.1.15 sent `auto` while its summary processor
rejected every tool call, causing retries. The native one-line patch is preserved
in `clients/patches/mimo-compaction.patch` (tested against source `6babeb0`). It
keeps the frozen tool catalog and summary execution prohibition. A separate
patched build passed the test; the launcher does not install or select it
automatically. The ordinary smoke also checks session-memory writes and inbox
reads without approval cards, using only temporary files and a fake provider.
It also rejects a native permission request and verifies that the completed
turn is reported as stopped, is not replayed, and does not block the next
Telegram message. MiMo can omit `finish` on that terminal path.
