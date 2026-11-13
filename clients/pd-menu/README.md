# pd: local terminal window menu

An optional tmux front end for PolyDaemon's workspace launchers. Browse local
workspaces, choose an agent, and attach to an existing terminal or launch a new
one. There is no additional daemon or Telegram credential to configure.

[Russian guide](README.ru.md). Interactive labels currently use Russian;
commands and agent identifiers are English.

## Requirements

- macOS or Linux, Bash 4+, tmux, and standard Unix tools.
- `dialog` or `whiptail` for the visual menu; otherwise a numbered text menu.
- Working PolyDaemon launchers in each workspace. This utility does not install
  agents, register MCP servers, or configure the router.

On macOS, install `bash`, `tmux`, and optionally `dialog` with Homebrew. Ensure
Homebrew's bin directory precedes `/bin` in PATH: Apple's Bash 3.2 is too old.
Native Windows is not supported. WSL has not been validated.

## Try it

From your PolyDaemon checkout:

```sh
./clients/pd-menu/pd help
./clients/pd-menu/pd ws
./clients/pd-menu/pd
```

It searches `~/Work` by default. Override that without editing scripts:

```sh
PD_WORK_DIR="$HOME/projects" ./clients/pd-menu/pd
```

For a persistent `pd` command, create a symlink in a directory already on PATH:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/clients/pd-menu/pd" "$HOME/.local/bin/pd"
```

Run those commands from the checkout root. An existing `pd` is not overwritten.
Keep the whole `clients/pd-menu` directory: the entry point loads adjacent modules.
Removing the symlink uninstalls the command without closing any sessions.

## Everyday commands

```sh
pd ls                           # local tmux sessions
pd ws                           # discovered workspaces and agent launchers
pd attach my-project codex      # attach to a running window
pd start my-project claude      # attach if running, otherwise invoke resume
pd start my-project codex new   # explicitly launch a fresh session
```

Detach with `Ctrl-b d` to leave work running. Inside tmux, attach switches the
current client rather than nesting clients. The menu's stop action terminates
the chosen tmux session after confirmation.

`resume` delegates to the workspace launcher. The menu does not choose or verify
a model thread, guarantee history recovery, or deduplicate model operations.
The interactive option to open another resume window can target the same thread;
prefer attaching to the existing window. CLI selection currently picks the first
matching session when multiple windows exist; use the menu to select one explicitly.

## What status means

Connected/background refers to tmux clients, **not** Telegram or MCP health.
Activity is a terminal activity timestamp, not proof that an agent is working.
Agent names are inferred from session-name prefixes, not authenticated identity.
Only this host's tmux sessions are shown; iTerm tabs outside tmux are not listed.
This utility provides neither host failover nor reboot recovery.

## Configuration and safety

Use environment variables or `~/.config/pd-menu/config`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PD_WORK_DIR` | `~/Work` | Workspace search root |
| `PD_DEPTH` | `2` | Workspace search depth |
| `PD_UI` | `auto` | `dialog`, `whiptail`, or `plain` |
| `PD_START_CHECK_SEC` | `3` | Initial launcher failure check, not a readiness probe |
| `PD_PRUNE` | See `lib/core.sh` | Directory names excluded from discovery |
| `PD_TMUX_SOCKET` | unset | Optional separate tmux server name |

The config and workspace launchers are executable shell code: use trusted files.
Launch transfers exported environment variables through a temporary mode-0600
file, removed after reading. Treat that file as sensitive; an interrupted launch
may leave it behind. No keys or tokens are bundled with this utility.

## Tests

```sh
cd clients/pd-menu
shellcheck -x pd lib/*.sh agents/*.sh tests/menu-size.sh
./tests/menu-size.sh
PD_CONFIG_FILE=/dev/null ./tests/smoke.sh
```

Smoke tests use stub agents and a separate tmux socket, not real model sessions.
Tested on Linux and macOS. Terminal resizing tests do not establish compatibility
with every terminal emulator or guarantee agent readiness.
