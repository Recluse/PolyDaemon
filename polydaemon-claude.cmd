@echo off
REM polydaemon-claude.cmd - launch claude in this workspace with tg-bridge + bypassPermissions.
REM --name is derived from this file's parent folder, so the same .cmd works dropped into any workspace.
REM Extra args (%*) are passed through to claude. Example: tg-claude --model claude-opus-4-8
setlocal enableextensions
cd /d "%~dp0"
for %%I in ("%CD%") do set "NAME=%%~nxI"
REM Resume the prior conversation only if a transcript actually exists. A window whose
REM history was lost (e.g. a full disk truncated the .jsonl) has a stale/empty session
REM dir, and --continue on it can fail to start the window. claude stores transcripts at
REM %USERPROFILE%\.claude\projects\<cwd, with : and \ replaced by ->\<id>.jsonl.
REM An alias workspace (a junction giving another workspace a second name) is entered
REM path, but claude resolves it and stores the transcript under the REAL path. Keying
REM ENC on %CD% therefore looked in a directory that never exists, so --continue was
REM silently never passed and such a window always started blank while its history sat
REM intact under the real path (found 2026-09-09 on a junction workspace).
REM cmd cannot resolve a junction: no path modifier and no pushd resolve it, so read
REM the target out of `dir /al` instead. (Do NOT name the path-modifier token in a
REM comment: cmd still parses it inside REM and ABORTS the whole batch on it.)
REM Its bracketed form is locale-independent, unlike fsutil's.
REM The match is anchored by a leading space and a trailing " [" so a name that is a
REM prefix of another (infra vs infra-win) cannot resolve to the wrong target. A plain
REM directory produces no line and falls back to %CD%.
for %%I in ("%CD%") do set "PARENT=%%~dpI"
for %%I in ("%CD%") do set "LEAF=%%~nxI"
set "REAL="
for /f "tokens=2 delims=[]" %%R in ('dir /al "%PARENT%." 2^>nul ^| findstr /i /c:" %LEAF% ["') do set "REAL=%%R"
if not defined REAL set "REAL=%CD%"
set "ENC=%REAL::=-%"
set "ENC=%ENC:\=-%"
set "CONT="
if exist "%USERPROFILE%\.claude\projects\%ENC%\*.jsonl" set "CONT=--continue"
REM This launcher always passes the channels flag, so tell the plugin so: its own
REM check reads the parent's command line through WMI, which can stall startup.
set "TG_BRIDGE_FORCE_CHANNELS=1"
REM A window, never a headless run: the plugin reads CLAUDE_CODE_ENTRYPOINT=sdk-cli
REM as headless, and a value inherited from another claude would hide this window.
set "CLAUDE_CODE_ENTRYPOINT="
REM A per-window identity its hooks inherit, so they find THIS window's plugin
REM even when another window has the same folder (as clients/polydaemon-claude.sh does).
if not defined TG_WINDOW_UID set "TG_WINDOW_UID=%COMPUTERNAME%-%RANDOM%%RANDOM%%RANDOM%"
call claude.cmd --dangerously-load-development-channels server:tg-bridge %CONT% --name "%NAME%" --permission-mode bypassPermissions %*
endlocal
