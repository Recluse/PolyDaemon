# Works well with

These integrations are optional. PolyDaemon routes Telegram messages, progress
and owner approvals to agent windows; it does not need a memory database.

## HyperMnesia — memory

[HyperMnesia](https://github.com/Recluse/HyperMnesia) is self-hosted long-term
memory for coding agents: your repositories' docs made searchable, a map from
file paths to the `must` rules that cover them — injected before an edit — and
personal memory of facts, preferences and decisions carried from one session to
the next. It is a separate MIT project, with its own installation, database,
credentials and lifecycle. Neither project installs or deploys the other.

```text
Telegram <-> PolyDaemon <-> agent window <-> HyperMnesia MCP <-> memory store
```

PolyDaemon delivers the conversation, not the memory: the agent calls
`memory_search`, `memory_get`, `search_docs`, `get_project_map` or
`get_constraints` through its own MCP client. This also works without Telegram.
Installing the bridge does not ingest documentation, capture transcripts, or
grant permission to write memories.

With PolyDaemon you run many windows over many projects, often from a phone and
without looking at the code; that is exactly when an agent should not have to be
told the same rules again.

**Wiring a window.** Install HyperMnesia using its
[INSTALL guide](https://github.com/Recluse/HyperMnesia/blob/main/docs/INSTALL.md#mcp-client)
and register its MCP server in the selected agent's configuration: `.mcp.json`
for Claude Code, the Codex MCP configuration, or OpenCode's native MCP server
configuration. Do not copy one agent's configuration format into another.
The public HyperMnesia setup uses `HM_REPO`. Follow its setup documentation and
match the indexed repository tag exactly, including case. A connected MCP
server with the wrong project tag may return no project map.

**Its hooks.** The automatic half — rules before an edit, memory recalled per
prompt, sessions captured — is a set of Claude Code hooks you register by hand;
[its MEMORY guide](https://github.com/Recluse/HyperMnesia/blob/main/docs/MEMORY.md)
lists them. They sit beside PolyDaemon's safely, and for a reason worth knowing:
its PreToolUse hook on edits deliberately returns **no** permission decision. A
hook that answered `allow` there would approve every edit on its own and undo
PolyDaemon's approval gate. PolyDaemon's own installer recognises its entries by
the hook file they run, so it replaces its own and never touches anyone else's.

These are Claude Code hooks, not a promise of automatic recall or transcript
capture in Codex or OpenCode. Those clients can use the MCP tools; automatic
delivery needs an explicitly supported adapter. Start with read-only tools if
you do not want agents writing or superseding memories.

**Interpreting status.** MCP `Connected` means the transport connected, not
that this project's index is complete or fresh. A successful `get_project_map`
can show an available or missing map; a cached response does not prove the
database is currently reachable. Do not infer document counts, indexing time
or freshness from this tool: its current text contract does not expose them.
Newer servers expose read-only `project_status({})` with a versioned structured
snapshot: scoped document/chunk counts, SHA256 freshness of indexable Markdown,
changed/unindexed/missing counts, map presence and check time. The root and repo
come from server configuration, not caller arguments. This is not install-wide
health, an audit of every code file, or the timestamp of a completed full ingest.
Older servers remain usable with unknown counts/freshness.

See [OpenCode integration](opencode.md) and [Codex integration](codex.md) for
the bridge side. HyperMnesia's memory/ingest documentation remains authoritative
for the memory side. A failed optional memory connection does not replace the
Telegram bridge with another project's topic or grant extra permissions.

## Serena — code navigation

[Serena](https://github.com/oraios/serena) gives the agent semantic code tools —
find a symbol, its references, edit at the symbol level — backed by language
servers, instead of reading files line by line. Install it as its README says
(`uv tool install`, not from a marketplace), then register it once for every
project:

```sh
claude mcp add --scope user serena -e SERENA_USAGE_REPORTING=false -- "$HOME/.local/bin/serena" \
  start-mcp-server --context claude-code --project-from-cwd --enable-web-dashboard false
```

- **Use the full path**, expanded by your shell (`$HOME`, not `~`, which would be
  stored literally). Windows started by `/launch` come from a launch agent, and a
  service does not have your interactive `PATH` — a bare `serena` is not found
  there and the server silently does not start. The name goes before `-e`: `-e`
  takes several values and would swallow it.
- **`--project-from-cwd`** makes each window's Serena work on its own folder. It
  looks for `.git` or `.serena/project.yml` and otherwise falls back to the
  folder itself, so a window whose folder only *contains* checkouts gets the
  wrong project.
- **Check `ignore_all_files_in_gitignore`** in the generated
  `.serena/project.yml`. With `false`, Serena reads git-ignored files — `.env`
  included.
- `--enable-web-dashboard false` keeps it from opening a local web port per
  window, and `SERENA_USAGE_REPORTING=false` turns its telemetry off.
