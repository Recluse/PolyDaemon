@echo off
REM The venv the getting-started guide creates is tg-bot\.venv; an older layout
REM kept it at the repository root. Use whichever exists.
if exist "%~dp0tg-bot\.venv\Scripts\activate.bat" (
  call "%~dp0tg-bot\.venv\Scripts\activate.bat"
) else (
  call "%~dp0.venv\Scripts\activate.bat"
)
cd /d "%~dp0tg-bot"
python tgbridge.py
