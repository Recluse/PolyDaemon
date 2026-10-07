#!/usr/bin/env bash
# launch-ws.sh — macOS launcher: open a Terminal window running a workspace's
# polydaemon-claude.sh (the counterpart of Windows launch-ws.ps1). Finds the workspace by
# folder name under TG_WORK_DIR (default ~/Work).
#
#   ./launch-ws.sh <workspace-name>   open that workspace in a new Terminal window
#   ./launch-ws.sh <name> <dir>       open <dir> itself if it holds polydaemon-claude.sh
#                                     (what the bot sends); else search by name
#   ./launch-ws.sh -l                 list launchable workspaces (those with polydaemon-claude.sh)
#
# Opens a TAB in iTerm2 when iTerm2 is there, otherwise a Terminal.app window.
# On Linux — and on macOS with TG_MAC_TERMINAL=tmux — it starts a DETACHED tmux
# session pd-<name> instead (attach with `tmux attach -t pd-<name>`), which is
# also what lets the bot type into the window later.
#   TG_MAC_TERMINAL=iterm|terminal|tmux|auto   which one to use      [default auto]
#   TG_MAC_NUDGE=1|0                      answer claude's startup prompts  [default 1]
# auto = iTerm2 if the system can resolve it, else Terminal. A tab rather than a
# window because that is where these actually live: one iTerm2 window with a tab
# per workspace, not a screen full of loose windows.
#
# ⚠️ Driving iTerm2 means AppleScript, and the FIRST such launch raises the macOS
# Automation consent dialog ("<app> wants to control iTerm") for whatever process
# runs this — the launch-agent when the bot starts a window, your shell when you
# run it by hand. Approve it once per app. If it is refused, osascript fails and
# this falls back to a Terminal.app window rather than launching nothing.
#
# The startup prompts ARE answered now (TG_MAC_NUDGE=0 turns it off) — see the
# `nudge` handler below for which ones and why only those. macOS has no
# AttachConsole/WriteConsoleInput like the Windows launcher, but iTerm2's
# AppleScript can both read a session's screen and write to it, which is better
# than the Windows approach: it looks before it types.
set -euo pipefail

WORK_DIR="${TG_WORK_DIR:-$HOME/Work}"

list_ws() {
  find "$WORK_DIR" -maxdepth 5 \( -name polydaemon-claude.sh -o -name tg-claude.sh \) -not -path '*/node_modules/*' 2>/dev/null \
    | while read -r f; do d="$(dirname "$f")"; printf '  %-24s %s\n' "$(basename "$d")" "$d"; done | sort -u
}

[ $# -ge 1 ] || { echo "usage: launch-ws.sh <workspace-name> | -l | --check"; exit 1; }
if [ "$1" = "-l" ] || [ "$1" = "--list" ]; then
  echo "launchable (have polydaemon-claude.sh) under $WORK_DIR:"; list_ws; exit 0
fi

# --check: everything that can be verified WITHOUT opening a window or raising
# the Automation consent dialog. Worth having as a command rather than a note:
# the AppleScript is a heredoc inside a shell script, so a typo in it is invisible
# until someone taps Launch, and `osacompile` resolves the iTerm2 dictionary terms
# (create tab with default profile, current session, write text) for real.
if [ "$1" = "--check" ]; then
  bash -n "$0" || { echo "FAIL: shell syntax"; exit 1; }
  if command -v osacompile >/dev/null 2>&1; then   # macOS only; Linux uses tmux
    sed -n '/^on run argv$/,/^end run$/p' "$0" > "${TMPDIR:-/tmp}/tgws_check_$$.applescript"
    [ -s "${TMPDIR:-/tmp}/tgws_check_$$.applescript" ] || { echo "FAIL: AppleScript block not found"; exit 1; }
    osacompile -o "${TMPDIR:-/tmp}/tgws_check_$$.scpt" "${TMPDIR:-/tmp}/tgws_check_$$.applescript" \
      || { echo "FAIL: AppleScript does not compile"; exit 1; }
    rm -f "${TMPDIR:-/tmp}/tgws_check_$$.applescript" "${TMPDIR:-/tmp}/tgws_check_$$.scpt"
  fi
  if TG_MAC_TERMINAL=nonsense bash "$0" --probe-bad-value 2>/dev/null; then
    echo "FAIL: an unknown TG_MAC_TERMINAL must be refused, not guessed"; exit 1
  fi
  echo "launch-ws self-check OK (shell + AppleScript compile + config guard)"
  exit 0
fi

# Used only by --check above: reach the TG_MAC_TERMINAL guard without needing a
# real workspace on disk.
if [ "$1" = "--probe-bad-value" ]; then
  case "${TG_MAC_TERMINAL:-auto}" in
    iterm|terminal|tmux|auto) exit 0 ;;
    *) exit 1 ;;
  esac
fi

NAME="$1"
DIR=""
[ $# -ge 2 ] && { [ -f "$2/polydaemon-claude.sh" ] || [ -f "$2/tg-claude.sh" ]; } && DIR="$2"
[ -n "$DIR" ] || while IFS= read -r d; do
  { [ -f "$d/polydaemon-claude.sh" ] || [ -f "$d/tg-claude.sh" ]; } && { DIR="$d"; break; }
done < <(find "$WORK_DIR" -maxdepth 5 -type d -name "$NAME" -not -path '*/node_modules/*' 2>/dev/null)
[ -n "$DIR" ] || { echo "workspace '$NAME' not found under $WORK_DIR (needs polydaemon-claude.sh). Try -l."; exit 1; }
SCRIPT=polydaemon-claude.sh
[ -f "$DIR/$SCRIPT" ] || SCRIPT=tg-claude.sh

open_in_terminal_app() {
  # A .command file double-clickable/openable by Terminal — avoids osascript
  # quoting entirely. printf %q quotes the path for the shell, so spaces and
  # special characters survive.
  local tmp="${TMPDIR:-/tmp}/tgws_$$.command"
  printf '#!/bin/bash\ncd %q && exec bash ./%q\n' "$DIR" "$SCRIPT" > "$tmp"
  chmod +x "$tmp"
  open "$tmp"   # Terminal runs it (default handler for .command)
}

open_in_iterm() {
  # The directory goes in as an ARGUMENT, not interpolated into the script text:
  # AppleScript string escaping and shell quoting stacked on each other is how a
  # path with a space or an apostrophe turns into a syntax error at launch time.
  # `quoted form of` then quotes it for the shell inside the session.
  osascript - "$DIR" "${TG_MAC_NUDGE:-1}" "$SCRIPT" <<'APPLESCRIPT'
on run argv
	set cmd to "cd " & quoted form of (item 1 of argv) & " && exec bash ./" & quoted form of (item 3 of argv)
	set doNudge to ((item 2 of argv) is not "0")
	tell application "iTerm"
		activate
		-- No window to add a tab to (iTerm2 not running, or all windows closed):
		-- make one. Asking for a tab of a window that does not exist is an error,
		-- and an error here means no window and no explanation.
		if (count of windows) is 0 then
			set w to (create window with default profile)
			set sess to current session of w
		else
			tell current window
				set tb to (create tab with default profile)
				set sess to current session of tb
			end tell
		end if
		tell sess to write text cmd
		if doNudge then my nudge(sess)
	end tell
end run

-- Answer claude's startup prompts, which otherwise leave the window sitting
-- there until a human clicks — useless for a /launch from Telegram.
--
-- It READS THE SCREEN before every keypress, and answers only a prompt that is
-- BOTH recognised by name AND still waiting for an answer. Both halves are
-- needed, and the second one is the half that is easy to miss: the prompt's text
-- stays in the scrollback forever after it is answered. Measured on this machine
-- while auditing — a live agent's session still contained "I am using this for
-- local development" from its own startup, so a name-only test would have
-- matched it. "Enter to confirm" is only on screen while something is actually
-- pending, and that same session did not have it.
--
-- Blind Enters (what the Windows launcher sends) are fine there because it
-- drives a console it just created. Here the session is also brand new, but that
-- is an assumption about the caller rather than something this handler can see,
-- so it does not rest on it.
--
-- Two prompts are handled because two were OBSERVED, both verified by hand on
-- 2026-09-24:
--   "Yes, I trust this folder"              — second item, so ↓ then Enter
--   "I am using this for local development" — already selected, so Enter
-- The session-resume prompt mentioned in older notes is deliberately NOT here:
-- it has not been seen, and guessing a keypress for a menu whose layout is
-- unknown is how you resume the wrong session.
on nudge(sess)
	tell application "iTerm"
		set didTrust to false
		set didChannels to false
		-- 60 × 0.5 s. Long enough for a cold start, short enough that a window
		-- stuck on something unknown is left alone rather than poked forever.
		repeat 60 times
			delay 0.5
			set c to contents of sess
			-- The TUI footer: the window is up, nothing left to answer.
			if c contains "bypass permissions on" then exit repeat
			-- Only on screen while a prompt is WAITING. Without it these tests
			-- match a prompt that was answered long ago and is merely still
			-- scrolled back.
			set pending to (c contains "Enter to confirm")
			if pending and (not didTrust) and (c contains "Yes, I trust this folder") then
				write sess text ((ASCII character 27) & "[B") newline no
				delay 0.3
				write sess text "" newline yes
				set didTrust to true
			else if pending and (not didChannels) and (c contains "I am using this for local development") then
				write sess text "" newline yes
				set didChannels to true
			end if
		end repeat
	end tell
end nudge
APPLESCRIPT
}

# Same screen-reading as the AppleScript `nudge` above — see there for which
# prompts and why only while "Enter to confirm" is on screen.
nudge_tmux() {
  local t="=$1:" c did_trust=0 did_ch=0 i   # "=name:" = exactly this session, its active pane
  for i in $(seq 60); do
    sleep 0.5
    c="$(tmux capture-pane -p -t "$t" 2>/dev/null)" || return 0   # session gone
    case "$c" in *"bypass permissions on"*) return 0 ;; esac
    case "$c" in *"Enter to confirm"*) ;; *) continue ;; esac
    if [ $did_trust = 0 ] && [[ "$c" == *"Yes, I trust this folder"* ]]; then
      tmux send-keys -t "$t" Down; sleep 0.3; tmux send-keys -t "$t" Enter; did_trust=1
    elif [ $did_ch = 0 ] && [[ "$c" == *"I am using this for local development"* ]]; then
      tmux send-keys -t "$t" Enter; did_ch=1
    fi
  done
}

open_in_tmux() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is not installed" >&2; return 1; }
  # The same two steps as polydaemon-claude.sh (window name, then session name), or a
  # hand-started window and a /launch of the same folder get different sessions.
  local wname sess
  wname="$(printf %s "$(basename "$DIR")" | tr -cs '[:alnum:]._-' '_')"
  sess="pd-$(printf %s "$wname" | tr -c '[:alnum:]_-' '-')"
  if tmux has-session -t "=$sess" 2>/dev/null; then
    echo "tmux session $sess already exists — attach with: tmux attach -t $sess" >&2
    return 1
  fi
  tmux new-session -d -s "$sess" -c "$DIR" "bash ./$SCRIPT" || return 1
  [ "${TG_MAC_NUDGE:-1}" = 0 ] || nudge_tmux "$sess"
  echo "launched '$NAME' in tmux session $sess -> $DIR"
}

TERMINAL="${TG_MAC_TERMINAL:-auto}"
[ "$(uname -s)" = Linux ] && TERMINAL=tmux
if [ "$TERMINAL" = "auto" ]; then
  # A lookup, not automation — this does not raise the consent dialog.
  if osascript -e 'id of application "iTerm"' >/dev/null 2>&1; then
    TERMINAL="iterm"
  else
    TERMINAL="terminal"
  fi
fi

case "$TERMINAL" in
  iterm)
    if open_in_iterm; then
      echo "launched '$NAME' in an iTerm2 tab -> $DIR"
    else
      # Automation refused, iTerm2 gone, whatever it was: say so and still open
      # the window. Silence with no window is the one outcome to avoid.
      echo "iTerm2 launch failed for '$NAME' — falling back to Terminal.app" >&2
      open_in_terminal_app
      echo "launched '$NAME' -> $DIR"
    fi
    ;;
  terminal)
    open_in_terminal_app
    echo "launched '$NAME' -> $DIR"
    ;;
  tmux)
    open_in_tmux
    ;;
  *)
    echo "TG_MAC_TERMINAL='$TERMINAL' is not one of iterm|terminal|tmux|auto" >&2
    exit 1
    ;;
esac
