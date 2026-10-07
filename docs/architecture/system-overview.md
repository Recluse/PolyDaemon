# System Overview

## Context

`tg-copilot-bridge` связывает Telegram и Claude Code (в окне VS Code или в
консоли) через локальный HTTP+MCP bridge. Telegram-трафик идёт через
self-hosted Bot API сервер на bot-host (лимит файлов ~1990MB).

```text
Telegram User
     │  (Bot API)
     ▼
[telegram-bot-api @ bot-host (Docker)] ◄── ssh -L 8081 ── локальный :8081
     │
     ▼  getUpdates через localhost:8081
[Python Router Bot]  ← запущен tray-app'ом (bots_tray.py)
     │  window select, /commands, topic↔window routing
     │
     │  HTTP POST  →  выбранному окну
     ▼
[Channel Plugin]  ──MCP notifications/claude/channel──►  Claude Code
     │  (Bun/TS, один на claude-сессию)                       │
     │  строка в ~/.tg-copilot-bridge/bot.db (instances)      │ reply tool
     └────── Telegram sendMessage (через :8081) ◄─────────────┘

[Хуки ~/.claude/hooks/tg-*.js] — approvals/questions/plans/notifications/
  stop-mirror из claude в TG; гейт = "плагин подключён к этому claude"
  (parent_pid match в bot.db через tg-bridge-locate.js)
```

## Components

| Component | Responsibility |
|-----------|----------------|
| telegram-bot-api (bot-host, Docker) | Self-hosted Bot API: getUpdates/sendMessage/getFile с лимитом ~1990MB; доступен локально через ssh-туннель `:8081` |
| Tray app (`bots_tray.py`, infra repo) | Менеджер процессов: автостарт/рестарт роутер-бота и туннеля, статус в системном трее |
| Python Router Bot (`tg-bot/`) | Единственный поллер Telegram; маршрутизация: форум-топик → его окно, reply → окно-отправитель, иначе активное окно; топики-на-окно; permission-режимы воркспейсов |
| Channel Plugin (`channel-plugin/`) | MCP-сервер (Bun/TS), спавнится claude'ом; принимает HTTP POST от бота; пушит в claude через `notifications/claude/channel`; шлёт ответы в TG напрямую; heartbeat в bot.db |
| Claude Code | Получает сообщения через Channel, отвечает `reply` tool; запускается через VS Code-расширение ИЛИ `tg-claude.cmd` в консоли |
| Хуки (`~/.claude/hooks/`) | PreToolUse/Notification/Stop-мосты: approvals, AskUserQuestion, ExitPlanMode, нотификации и stop-mirror в TG |
| VS Code Extension (`vscode-extension/`) | Авто-спавн терминала с claude+флагами; локальный approve-UI endpoint |

## Key Principles

- Каждая claude-сессия (VS Code-окно или консоль) запускает свой channel
  plugin на отдельном порту; идентичность окна = `workspace_name`,
  привязка топика = канонический `cwd` (буква диска в верхнем регистре,
  `canonicalCwd`/`canonical_cwd` на обеих сторонах).
- Только Python bot поллит Telegram; плагины принимают HTTP и шлют
  sendMessage сами (общий token, конфликтов с polling нет).
- Реестр окон — таблица `instances` в `~/.tg-copilot-bridge/bot.db`
  (SQLite WAL): heartbeat 15с, бот реапит строки по start-time-токену
  (PID-reuse-proof). Файловый реестр `instances/*.json` упразднён.
- Claude Code хранит контекст в своей сессии (`--continue` резюмит по cwd);
  бот историю не ведёт.
- Хуки активны только когда у claude подключён плагин (запуск с
  `--dangerously-load-development-channels server:tg-bridge`); standalone
  claude получает нативный flow без вмешательства.
- Approval-пути fail-closed: сбой доставки в TG = deny, не allow.
- Claude Code Channels требует ≥ 2.1.80; хуки требуют Node ≥ 22.5
  (node:sqlite).

## Related Documents

- [http-mcp-protocol.md](http-mcp-protocol.md)
- [channel-plugin.md](channel-plugin.md)
- [telegram-bot.md](telegram-bot.md)
- [../getting-started.md](../getting-started.md)
- [../requirements/functional-requirements.md](../requirements/functional-requirements.md)
