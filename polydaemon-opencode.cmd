@echo off
setlocal EnableExtensions
set "REPO=%TG_BRIDGE_REPO%"
if defined REPO goto ready
if exist "%~dp0clients\polydaemon-windows.ps1" set "REPO=%~dp0"
if defined REPO goto ready
if exist "%USERPROFILE%\.config\polydaemon\windows-repo-path" set /p REPO=<"%USERPROFILE%\.config\polydaemon\windows-repo-path"
if defined REPO goto ready
if exist "%USERPROFILE%\.config\polydaemon\repo-path" set /p REPO=<"%USERPROFILE%\.config\polydaemon\repo-path"
:ready
if not exist "%REPO%\clients\polydaemon-windows.ps1" (
  echo polydaemon: set TG_BRIDGE_REPO to the checkout or configure ~/.config/polydaemon/windows-repo-path 1>&2
  exit /b 1
)
pwsh.exe -NoProfile -File "%REPO%\clients\polydaemon-windows.ps1" -Agent opencode -Workspace "%~dp0." %*
exit /b %errorlevel%