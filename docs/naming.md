# Naming and compatibility

PolyDaemon is the product name in the CLI, UI, packages and documentation.
HyperMnesia is the optional memory companion, not part of the bridge.

## Launchers

| Agent | macOS / Linux | Windows |
| --- | --- | --- |
| Claude Code | `clients/polydaemon-claude.sh` | `polydaemon-claude.cmd` |
| Codex | `clients/polydaemon-codex.sh` | `clients/polydaemon-codex.ps1` |
| OpenCode | `clients/polydaemon-opencode.sh` | Not provided |
| MiMo Code | `clients/polydaemon-mimo.sh` | Not provided |

Copy shell launchers into the target project and make them executable. The
root Codex, OpenCode and MiMo shell launchers are identical convenience copies of
the templates. The Codex PowerShell launcher stays beside `start-agentd.ps1`;
pass the target directory with `-Workspace`.

Workspace discovery prefers `polydaemon-claude.sh` / `.cmd` and also accepts
existing `tg-claude.sh` / `.cmd` copies. Existing copied Codex and OpenCode
launchers continue to work; no project folders or running windows are changed
by this source rename. Update external references to the old checkout paths
when upgrading. Historical incident notes retain their original terminology.

## Stable integration identifiers

These names intentionally remain unchanged; they are not product labels:

- Claude/Codex MCP key `tg-bridge`, tool prefixes and Claude's
  `server:tg-bridge` channel flag.
- `TG_*` environment variables and the `hooks/tg-*.js` installation paths.
- State directories `.tg-bridge`, `.tg-bridge-channel`, `.tg-copilot-bridge`.
- OpenCode's installed `plugins/tg-bridge` loader and plugin ID.
- Launchd label `com.tg-bridge.agentd` and Windows daemon mutex.
- VS Code extension ID `local.tg-copilot-bridge` and legacy configuration keys.

Renaming these independently would lose state, detach existing clients or
invalidate permission rules. Their migration requires an explicit versioned
upgrade, not a text replacement. New user-facing text uses PolyDaemon.
