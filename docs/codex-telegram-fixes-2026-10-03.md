# Codex Telegram fixes — 2026-10-03

This runbook records the Windows session fixes and how to reproduce the shared
parts on macOS. Tested with npm Codex CLI 0.160.0. Local credentials, Telegram
inbox files and machine-specific MCP configuration are not committed.

## Changes included

- MR !2: after the Codex MCP handshake, the registered `<folder>-codex` name
  also becomes the outgoing signature and RPC identity. Local topic bindings
  use the physical workspace plus `#codex`; heartbeat still reports real cwd.
  Claude and Codex in the same folder keep separate forum topics.
- MR !3: Windows npm-native app-server discovery, hidden agentd supervisor,
  remote TUI launcher and conservative standalone-process detection. A
  standalone session must be closed before resuming through the bridge.
- Readable Codex inbound: sender name/username, chat title, forward origin and
  attachment summary precede the message. Exact reply/download arguments are
  retained in a JSON footer. Old router payloads fall back to the numeric user
  ID. Claude channel notifications retain their existing format.
- Local Codex reply policy: an explicit per-tool override allows the requested
  Telegram reply even when the CLI approval policy is `never`.

## Reproduce on macOS

1. Pull current `main` in the bridge checkout and install its documented Bun
   and Python dependencies. Install/verify CLI with
   `npm install -g @openai/codex@0.160.0` and `codex --version`.
2. Register MCP with `python3 hooks/install.py --mcp --codex`, using the existing
   machine credentials. Check `codex mcp list` for `tg-bridge`.
3. If MCP reply fails with “requires approval, but approval policy is never”,
   add this to `~/.codex/config.toml` (merge into the existing table):

   ```toml
   [mcp_servers.tg-bridge.tools.reply]
   approval_mode = "approve"
   ```

   This was verified against the installed 0.160.0 config/schema. It authorizes
   only this tool; it does not change the global approval policy. Relaunch the
   owning app-server to load the config, or use its documented JSON-RPC
   `config/batchWrite` with `reloadUserConfig: true` and
   `config/mcpServer/reload`. Do not print its bearer token.
4. Follow [Codex setup](codex.md): run `bun run agent/agentd.ts` or install the
   adjusted LaunchAgent from `agent/launchd/`. `~/.tg-bridge/agent.toml` must
   exist. Set `TG_CODEX_BIN` if the service cannot resolve Codex from PATH.
5. **Copy** `clients/tg-codex.sh` into each project and `chmod +x` it, then
   launch that copy. The script chooses its own directory as workspace; running
   the original from another cwd selects the bridge checkout. It attaches with
   `--remote` and explicit `--cd`, and resumes the folder's last known thread.
   Close old standalone windows first. Follow the hook setup/trust instructions
   in `docs/codex.md` if using the Telegram approval hooks.
6. Update/deploy the router bot too: sender and forward fields originate there.
   Restart/reload MCP clients after pulling the plugin update. Verify the topic
   is `<folder>-codex`, a reply has that signature, and a forwarded message
   shows both its sender and original source.

## Windows entry points

Use PowerShell 7 and `clients/tg-codex.ps1 -Workspace <project> resume`.
`-Check` checks daemon readiness without opening a UI. The project
`start-codex.cmd` invokes this script with `%CD%`. A copy was installed in
TgInviteSystem. Remove the old `--no-daemon` standalone path: the Windows
launcher strips that flag and reports it. The hidden supervisor starts on
demand, not at Windows logon. Logs are in `~/.tg-bridge/agentd.log`.

## Verified transport and reactions

- Outbound PNG and UTF-8 TXT arrived in Telegram; inbound photo was downloaded
  and visually inspected; inbound document size matched its Telegram metadata.
  Original sender hash was unavailable, so full byte equality is not claimed.
- Two ordinary `👌` reactions arrived through `receive` with `event: reaction`
  and the correct target message IDs. Reactions are **queue-only**: they do not
  start a model turn or appear automatically in the console. Poll `receive` to
  inspect them. Automatic console reaction display is not implemented here.
- Channel-state paths are blocked by the attachment guard. Keep test files in
  a separate Downloads directory; never send credentials or state backups.

## Validation

Run `bun test` in `channel-plugin`, and
`PYTHONPATH=tg-bot python3 -B tg-bot/test_inbound_context.py` at repository root.
The latter checks the actual router HTTP payload with Telegram message objects;
the former checks readable text, forwards, attachment metadata and old-router
fallbacks. Existing Windows guard checks: `bun test agent/windows-codex.test.ts`.
