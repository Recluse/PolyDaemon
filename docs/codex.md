# Codex windows (experimental)

See [2026-10-03 fixes and macOS reproduction](codex-telegram-fixes-2026-10-03.md)
for window identity, narrow reply approval, readable inbound and reaction checks.

A [Codex](https://github.com/openai/codex) window can sit beside the Claude
Code ones: its own forum topic, `<folder>-codex`, messages from Telegram pushed
straight into its thread, replies back to the topic. Tested on macOS.

Codex has no push channel of its own the way Claude Code has channels. So a small
per-machine daemon, `agent/agentd.ts`, runs **one** `codex app-server` and the
windows attach to it with `codex --remote`: when a Telegram message arrives, the
daemon starts (or steers) a turn in that folder's thread, and the window's TUI
shows it live.

## Setup

1. **Register the plugin for Codex too** — the same `machine.env` as for Claude:

   ```sh
   python3 hooks/install.py --mcp --codex
   ```

   It runs `codex mcp add tg-bridge …`, which writes `~/.codex/config.toml`.
   This selects Codex only: Claude Code is not required or modified. To also
   register Claude, run the same command separately without `--codex`.

2. **Run the daemon.** `bun run agent/agentd.ts` — the first run writes
   `~/.tg-bridge/agent.toml` (its port and token) and starts
   `codex app-server` on `ws://127.0.0.1:3210` (`TG_CODEX_WS_PORT`). If `codex`
   is not found, set `TG_CODEX_BIN` to its path. To keep it running on macOS, use
   the LaunchAgent in [`agent/launchd/`](../agent/launchd/) — adjust its paths
   first.

3. **Install the approval hook for Codex** — in `~/.codex/hooks.json`:

   ```sh
   python3 hooks/install.py --codex --dry-run
   python3 hooks/install.py --codex
   ```

   It registers one PreToolUse guard. Routine actions and inter-window communication
   pass automatically; pushes, deploys and explicit paths outside the window's
   workspace wait for a Telegram tap. Shell access through scripts must also be
   bounded by native sandbox permissions, not just this command classifier.
   Read-only file tools (including attachment image viewing) may read the bridge
   checkout and shared `~/.tg-bridge-channel`, `~/.tg-bridge`,
   `~/.tg-copilot-bridge`, and `~/.config/polydaemon` directories without a tap,
   in both Claude and Codex windows. Writes still require approval outside the
   workspace; path traversal and symlinks cannot extend this read exception.
   PermissionRequest
   separately forwards native sandbox/network approval prompts to Telegram.
   Owner-selected per-workspace autonomy is stored in
   `~/.tg-copilot-bridge/codex-autonomy.json`: absolute workspace paths map to
   `workspace` (routine native prompts inside the workspace) or `external`
   (also external file access). The same scope covers subagent tool requests
   routed through that window. Push/deploy checks and managed denials remain
   enforced. No filesystem profile or sandbox roots are changed by this file.
   A protected operation that also needs sandbox escalation can require both
   confirmations. Do not remove either hook to hide this: they guard different
   decisions, and the hook inputs do not provide a shared invocation ID for safe
   one-shot deduplication.
   Questions, plans and the reply mirror are Claude Code's and have no Codex
   counterpart, so they are not installed there.

   **Then trust it in Codex:** run `/hooks` in a Codex window and trust the
   changed entries. Codex runs only hook definitions you have reviewed, keyed by
   a hash of each one — until then they are simply off, the approval gate
   included. An update that only moves the checkout keeps the same definitions,
   so it does not ask again.

4. **Start a window** from the project folder with `clients/polydaemon-codex.sh` (copy
   or link it there, like `polydaemon-claude.sh`). It continues the folder's most recent
   saved thread when the daemon knows one. Empty loaded threads without a
   persisted rollout are eligible for Telegram delivery, not for resume.

   The launcher passes the physical workspace path explicitly with `--cd` in
   both the new-session and resume branches. A shell `cd` alone does not select
   the workspace of a remote app-server; a fresh session can otherwise use the
   daemon's cwd (`/` under launchd), leaving its plugin without a workspace topic.
   Existing windows keep their current configuration until relaunched.
   `TG_CODEX_NEW=1 ./polydaemon-codex.sh` explicitly starts a new conversation without
   looking up a resume ID; existing history is not removed.

## Limits

The daemon forwards app-server `error` and failed `turn/completed` notifications
to the live Codex window for that workspace. Model/API failures (including
capacity errors) appear in its Telegram topic; the two events for the same
failed turn produce one notice. Subagent errors are not presented as separate
window failures. This requires the updated daemon and channel plugin to be
loaded, not only an updated checkout.

- A thread held open by a Codex started **without** `--remote` is not written to:
  two processes on one thread corrupt it. Start Codex windows with
  `polydaemon-codex.sh`. Only native interactive CLI processes count as holders;
  `codex sandbox` tool kernels and management commands do not block delivery.
- macOS uses launchd; Windows uses the on-demand supervisor described below.

## Windows with npm Codex CLI

Use npm `@openai/codex`, Bun on PATH and PowerShell 7. `clients/polydaemon-codex.ps1 -Workspace <path> resume` starts the local bridge daemon when necessary and attaches the TUI to `ws://127.0.0.1:3210`. It resolves Bun from PATH, without reading Claude configuration, and resolves the native app-server executable from the npm Codex package. `-Check` checks readiness and prints the planned TUI arguments without opening a thread. CLI management commands bypass the remote UI path.

`clients/start-agentd.ps1` runs a hidden, per-user supervisor (named mutex prevents duplicates), starts the daemon from the user home and restarts it after exit. Config and logs: `~/.tg-bridge/agent.toml`, `~/.tg-bridge/agentd.log`. It starts on demand from the launcher, not at OS logon. HTTP binds to localhost:3200 with a generated bearer token; app-server is localhost:3210.

The launcher removes `--no-daemon`: a standalone CLI cannot share its current thread with the bridge-owned app-server. Close the standalone session first, then resume through the launcher. Windows concurrent-TUI detection uses Win32_Process; matching cwd or an unknown standalone cwd blocks delivery. A failed process inventory also refuses delivery. Existing `--remote` TUIs and app-server processes do not block it.

Checks: `bun test agent/windows-codex.test.ts`; run the Windows launcher with `-Check --no-daemon resume`; verify daemon health and read-only `/v1/codex/status`/`last-thread`. Full Telegram inbound delivery requires a TUI relaunched through this launcher.
