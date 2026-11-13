# shellcheck shell=bash
# Codex. Started by hand, codex-console.py names the session pd-codex-<random>;
# from this menu it gets pd-codex-<folder>. Both match the prefix. Inside a tmux
# pane the console splits off the PolyDaemon sidebar on its own.
pd_agent_register codex 'Codex' 'pd-codex-' polydaemon-codex.sh tg-codex.sh
