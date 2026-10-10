# Windows clean-session launchers

PowerShell 7 is required. Copy the four root `polydaemon-<agent>.cmd` files
beside the existing project launcher. They select their own directory as the
workspace, including spaces and junction aliases. Set `TG_BRIDGE_REPO` to the
checkout, or write its path into `~/.config/polydaemon/windows-repo-path`
(Windows override) / `~/.config/polydaemon/repo-path` (shared fallback).

Run `polydaemon-claude new`, `polydaemon-codex new`, `polydaemon-opencode new`
or `polydaemon-mimo new`. Only the first literal `new` is consumed; combining
it with resume/continue/session/fork selection is rejected before any agent or
daemon is started. Existing history is never deleted. Default Claude continues
when its physical workspace has transcripts; default Codex retains the existing
PowerShell launch behavior; OpenCode/MiMo retain their adapter resume behavior.

The shared dispatcher sets the native OpenCode/MiMo fresh-session environment
flag and calls the existing TypeScript adapter. Codex's internal PowerShell
launcher also accepts `new` directly, without forwarding it to Codex CLI.

`-Plan` on a root launcher prints its intended invocation without starting an
agent or daemon. Native verification: `python clients/test_polydaemon_windows.py`.
These checks cover actual cmd/PowerShell binding, fresh/default selection,
history preservation, conflicts and quoted workspace paths. They do not claim
an OpenCode/MiMo Windows model/Telegram roundtrip; those still need native
acceptance with the respective CLI installed.

Review follow-up: bare `fork` and Claude `--fork-session` are also conflicting
selectors. Actual CLI invocation is checked through native command stubs for
all four agents, not only the plan output. Installed MiMo `--version` returned
0.1.15. All 100 distributed launcher copies were hash-checked in 25 folders.

No running windows are restarted by copying the launchers.

## Launch requests from the bot

`launch-ws.ps1 -Dir <exact-folder> -Agent claude|codex|opencode|mimo`
selects the corresponding canonical cmd launcher. Default agent is Claude and
default session behavior is resume. `-NewSession` passes first argument `new`.
An explicit folder never falls back to searching another same-named workspace.
Legacy `tg-claude.cmd` is accepted only for default Claude, not a fresh session.
The read-only local registry blocks an already live window of the same agent
and physical workspace; another agent is neither blocked nor stopped.

Only Claude receives auto-compact settings and startup Enter/trust/resume
handling. Other agents receive no injected keys. `-Check` returns a read-only
launch plan without opening a console or writing settings. Native checks:
`python clients/test_launch_ws_windows.py`. This is a script contract check;
deployment of the bot/common launch-agent is coordinated separately.

The launch-ws suite runs by default under Windows PowerShell 5.1 using the
HTTP caller's exact host flags: `-NoProfile -ExecutionPolicy Bypass -File`,
positional name and explicit Dir/Agent/NewSession. Four tests passed there and
four under PowerShell 7. The root cmd dispatch suite (four passed) exercises
actual command stubs through cmd into PowerShell 7. Live GUI windows were not
opened during acceptance checks. Set `POLYDAEMON_LAUNCH_HOST=pwsh.exe` to repeat
the launch-ws suite under PowerShell 7.
