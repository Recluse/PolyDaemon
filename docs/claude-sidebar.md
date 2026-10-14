# Claude Terminal Sidebar

The optional `pd-sidebar` mod uses Claude Code's native terminal pane. It is not
a browser overlay or an iTerm integration: the terminal UI can be used over
SSH and in tmux. Claude Code 2.1.296 or newer is required for this integration.
The main sidebar requests 44 body columns; a width manually chosen in Claude
takes precedence. The separate agent viewer keeps Claude's default width.

## Data Sources

- Context tokens, context percent, model and rate limits come from Claude's
  native session API. Missing limits are unknown, not zero usage.
- PolyDaemon registration comes from the current window's authenticated
  `/status`. A missing topic is different from a transport error.
- PolyDaemon tasks come from authenticated `/tasks`, scoped by the bridge
  process rather than a window name chosen by the UI. Older bridges without
  that endpoint display unavailable.
- HyperMnesia uses the existing MCP `project_status` capability. Project counts
  and freshness must match the current project scope; install-wide health is
  not a substitute. The mod must not ingest documents or write memories.
- Claude 2.1.296 exposes an LSP tool, but no public mod API for language-server
  lifecycle. Tool availability does not establish that an LSP server is ready.
- Agents come from `agent.list`. Selecting a row opens a separate read-only
  pane using `session.messages({agentId})`, with messages, tool inputs and
  results. Number keys 1-9 select the displayed rows when the pane has focus;
  further agents are paginated. Native buttons also work with the keyboard
  over SSH. Escape or Back closes the viewer.

The agent viewer shows a bounded tail (20 messages, at most about 18,000
characters), updated by session events. It does not switch the main native
transcript or access transcript files. A denied or removed agent is unavailable,
not an empty successful result. Hidden reasoning is not requested or displayed.
Closing the viewer or changing its selected agent invalidates in-flight reads.
Memory status requires versioned, scoped values; missing counts stay unknown.
Failed refreshes do not retain a previous `fresh` result as a current reading.

The sidebar does not approve operations, drain incoming messages, change task
states, start language servers, or run model turns. Closing or reloading the
pane must not replay an agent tool.

## Installation

Preview the native CLI commands without changing files:

```sh
python3 hooks/install.py --sidebar --dry-run
```

Install only after reviewing the mod and explicitly choosing to enable it:

```sh
python3 hooks/install.py --sidebar
```

The optional installer builds a self-contained bundle under
`~/.config/polydaemon/claude-sidebar`, retains the previous owned bundle as a
backup, and invokes the native plugin marketplace/install commands. It does not
edit hooks, MCP descriptors, model configuration or permission rules. It never
restarts windows. Use `/reload-plugins` or a new Claude session to load changes.
The source checkout alone does not update an already installed bundle.

Remove the user-scoped plugin through the native CLI:

```sh
python3 hooks/install.py --sidebar --uninstall
```

The bundle and backups remain available for inspection. Other plugins and the
PolyDaemon bridge hooks remain installed.

## Upstream Contracts

- [Claude mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Mods API reference](https://code.claude.com/docs/en/plugins/mods/reference)
- [Local marketplace installation](https://code.claude.com/docs/en/plugin-marketplaces)

The version-matched types emitted by Claude Code remain the source of truth for
the UI API. Unknown runtime values must stay unknown in the presentation.

## Verification

Pure validation/formatting and the bundled reader run without Claude:

```sh
bun test clients/claude-sidebar.test.ts clients/claude-status.test.ts
python3 -m unittest discover -s hooks -p test_claude_sidebar.py
```

On a supported Claude build, run `claude plugin validate claude-mods/pd-sidebar`
and `claude plugin test claude-mods/pd-sidebar`. These fixture tests do not need
a model turn. A supported version and enabled function hooks are prerequisites;
the installer does not enable experimental features or upgrade Claude itself.
