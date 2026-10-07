#!/usr/bin/env bash
# codex-mcp.sh — macOS/Linux wrapper that runs Codex as an MCP server for Claude
# (companion to the Windows ~/.claude/codex-mcp.cmd). Register it in the client's
# ~/.claude.json as the `codex` MCP server:
#   "codex": { "type": "stdio", "command": "/abs/path/to/codex-mcp.sh", "args": [] }
# Then Claude gets the `codex` / `codex-reply` tools and can delegate to Codex in
# its own cwd. approval_policy=never + workspace-write sandbox so Codex never
# blocks on its own approvals but stays scoped to the workspace.
#
# Unlike Windows (managed install in a rotating hash dir), macOS/Linux codex is
# normally on PATH (npm/brew). If yours isn't, set CODEX_BIN to its full path.
set -euo pipefail
CODEX_BIN="${CODEX_BIN:-codex}"
exec "$CODEX_BIN" mcp-server -c approval_policy=never -c sandbox_mode=workspace-write "$@"
