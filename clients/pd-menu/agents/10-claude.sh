# shellcheck shell=bash
# Claude Code. polydaemon-claude.sh names its own tmux session pd-<folder>,
# so "pd-" is the shortest prefix and wins only when no other agent matches.
pd_agent_register claude 'Claude Code' 'pd-' polydaemon-claude.sh tg-claude.sh
