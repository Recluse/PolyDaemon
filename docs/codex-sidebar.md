# Codex terminal companion

PolyDaemon has an experimental read-only companion for Codex CLI. It runs in a
separate terminal pane, not inside Codex's renderer. It does not patch Codex,
install hooks, change global configuration, resume a thread, send a turn, or
answer approval requests. An existing local app-server is required.

## Run

An interactive `./polydaemon-codex.sh` now opens Codex and a 44-column sidebar
in the same console by default when tmux, Bun, Python curses and the current
PolyDaemon checkout are available. `./polydaemon-codex.sh new` works the same
way, with a fresh session. Outside tmux, the launcher attaches a new private
tmux session to this terminal; inside tmux it splits only the caller's pane.
It does not open a GUI terminal window. Closing Codex removes its sidebar;
detaching tmux leaves that owned console running normally.

`TG_CODEX_SIDEBAR=0 ./polydaemon-codex.sh` retains the plain CLI. Auto mode
prints a warning and falls back if dependencies are missing; `TG_CODEX_SIDEBAR=1`
requires them. Management commands and non-interactive calls retain their old
behavior. Existing copies in project folders need the updated launcher;
the repo's root and `clients/` copies are identical.

The console helper inserts a one-client loopback WebSocket relay between the
CLI and its original server. It forwards frames without changing requests,
responses, permissions or configuration. Only replies to that CLI's
`thread/start`, `thread/resume` and `thread/fork` bind the panel; global events,
other workspaces, failed replies and superseded requests cannot bind it.
The panel still makes its read requests directly to the original app-server.
Its private binding file is cleared during a session transition/disconnect.
The relay does not resume or reconnect the CLI on its behalf.

Temporary launch/environment and identity files live under the physical
workspace's `tmp/.polydaemon-codex-*` (directory 0700, files 0600). Environment
handoff is consumed once; cleanup belongs to that launcher only. No global
tmux configuration is changed, and no other panes are closed. In an existing
tmux session, use its normal pane-navigation keys; mouse behavior follows the
user's tmux configuration.

### Manual companion

Requirements: Bun, Python with curses, and a Codex app-server with the relevant
read APIs. macOS/Linux include curses; native Windows is not validated. tmux is
optional for a side-by-side layout and works through an SSH terminal.

From the PolyDaemon checkout, using the exact thread ID from Codex `/status`:

```sh
python3 clients/codex-sidebar.py --thread THREAD_ID --cwd /path/to/project
```

Inside an existing tmux window, append `--split` to open a 44-column pane on
the right. Otherwise run the command in a second terminal. This does not start
or stop Codex. Closing the sidebar stops only its reader process.

The default URL is `ws://127.0.0.1:3210` (or `TG_CODEX_WS_PORT`). `--url` accepts
only loopback WebSockets; use SSH forwarding for a remote server. For forwarded
servers, run the companion on the server too: physical cwd validation is local.
The current reader does not support app-server bearer authentication; do not
disable server authentication to accommodate it.

PolyDaemon details come from the read-only `bridge_status({})` tool on the
selected thread's native MCP connection. It requires no separate window UID.
For older plugins only, optional `--window-uid UID` binds the status helper to
that window's local registry identity. Without either, connection is still
shown from the native catalog, but topic/pending details remain unlinked.
The latest registry row or parent PID is never used to guess a topic.
The selected thread must also match the physical cwd.
Status polls always specify both thread ID and server name so they reuse that
thread's MCP connection, rather than run full discovery across unrelated
servers. Default registration aliases are `tg-bridge`, `PolyDaemon`,
`polydaemon` and `agentmem`, `HyperMnesia`, `hypermnesia`. Custom keys can be
selected with `--bridge-server NAME` / `--memory-server NAME` on the companion.
Names are lookup hints, not authority: tool annotations, server identity and
returned physical root are still validated before displaying details.
Session selection is always explicit: there is no global "latest session"
fallback, and it does not switch to another session after a disconnect.

Arrow keys scroll; `a` focuses the first agent; Enter or a mouse click opens its
visible transcript. Escape returns; `q` closes only the companion. It displays
up to 50 direct child agents, with a truncation label when more exist. Descendant
agents at deeper levels are not included in this first version.

## Data and boundaries

- **Session:** configured model/provider, runtime status, current local Git
  branch (or detached HEAD). Git reads have a two-second deadline and do not
  change the index. Inherited `GIT_*` overrides cannot redirect the read.
- **Limits:** actual account quota windows and reset times from
  `account/rateLimits/read`, labeled account-wide, not per-project. No estimated
  cost or inferred subscription balance. Missing/unsupported responses remain
  unavailable. Quotas refresh every 60 seconds. Windows are labeled `5h`,
  `Weekly`, or their actual duration rather than an unexplained minute count.
- **Agents:** `thread/list` with an explicit parent filter, then independent
  parent verification. Opening a transcript revalidates that relationship and
  reads up to eight recent turns. Visible messages and tool summaries only:
  reasoning and injected hook prompts are excluded. No transcript files are
  scanned or exported, and no transcript is sent to Telegram.
- **HyperMnesia:** an already loaded thread's connected MCP catalog must expose
  exactly one read-only, non-destructive `project_status`. The companion calls
  only that tool with `{}` via the existing native connection. Returned root,
  schema, freshness and counts are validated. It never reads/copies global MCP
  configuration or starts a separate MCP process. Older servers lacking this
  thread-scoped API report unavailable. A connected memory server with
  `get_project_map` and `memory_search` but without `project_status` is explicitly
  shown as connected with counts/freshness unknown. Checks run every 60 seconds.
- **PolyDaemon:** native MCP connection and status details are separate.
  The read-only `bridge_status` tool returns version 1, physical root, instance,
  topic, working state, pending counts and tasks, without credentials or request
  bodies. The reader validates scope and shape. Task lookup failure leaves the
  bridge connected and tasks unknown. Tool-call failure does not override a
  successful native connection check. Older plugins can use the explicit-UID
  helper fallback; without it no arbitrary registry row is adopted.
  Nothing in this UI approves or resolves those requests.
- **Context:** the launch relay observes `thread/tokenUsage/updated` only for
  its bound thread. The panel shows `last.totalTokens` and `modelContextWindow`,
  not cumulative usage across turns. Before an event (including manual mode
  without a relay), it says awaiting usage. Changes of session clear the value.
  This is last observed turn usage, not a live estimate of unsent input or
  Codex's adjusted usable-context calculation. No extra model request, resume,
  transcript-file scan or subscription is made to obtain it.
- **LSP:** no readiness is inferred from a tool catalog.

Session, bridge, memory, limits and the selected viewer poll independently.
RPCs have deadlines (8 seconds, 15 for project status). Connection loss clears
snapshots and retries the same server/thread after a delay. It does not mark
other windows offline. Terminal control characters are removed from displayed
data. It does not inspect Codex `auth.json`. Bridge credentials stay inside the
existing local status helper; they are never sent to the UI. There is no external
telemetry.

## Research and choice

Reviewed upstream documentation on 2026-10-15 (not security audits or runtime
acceptance of these third-party projects):

- [codex-hud](https://github.com/mullller/codex-hud) offers a terminal HUD and
  tmux integration based on local rollout files. Its default latest-session
  selection is unsuitable for multiple concurrent PolyDaemon windows.
- [tmux-agent-sidebar](https://github.com/hiroppy/tmux-agent-sidebar) provides
  multi-agent monitoring and worktree management through hooks. Installing a
  second window/controller stack is unnecessary for PolyDaemon's status view.
- [codex-dash](https://github.com/ArnabCodes/codex-dash) indexes local sessions
  and supports multi-machine snapshots; this is a broader session dashboard
  rather than our scoped sidebar.
- [Official app-server API](https://learn.chatgpt.com/docs/app-server) provides
  read operations without resuming a thread. The companion uses that boundary
  instead of parsing terminal output or installing another agent controller.

No third-party project code was copied or installed. This is a first version,
not full Claude sidebar parity or a distribution to every existing workspace.

## Verification

```sh
bun test ./clients/codex-sidebar.test.ts
bun test ./clients/codex-launch-proxy.test.ts
python3 clients/test_codex_sidebar.py
python3 clients/test_codex_console.py
PD_NATIVE_TMUX=1 python3 clients/test_codex_console.py
```

Local development acceptance: native Codex `0.162.0-alpha.17.2` with an isolated
HOME and one empty fixture thread through the relay, no model turns; loopback
RPC tests; curses PTY render/navigation/close checks at narrow and wide sizes;
real isolated tmux with a fake CLI for default/new/resume and already-tmux entry.
Native Windows and
Linux/SSH acceptance are still pending. No existing sessions need restarting.
