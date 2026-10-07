# Non-Functional Requirements

## Security

### NFR-001 Local-only exposure

- Channel Plugin HTTP server должен слушать только `127.0.0.1`.
- Реестр `~/.tg-copilot-bridge/instances/*.json` должен создаваться с правами `0o600`.
- Bot token хранится только в `config.yaml` и env переменных; не логируется.

### NFR-002 Request authorization

- Каждый запрос bot → plugin должен содержать корректный `auth_token` в заголовке `Authorization: Bearer`.
- Bot должен поддерживать whitelist `allowed_users` по Telegram user ID.
- Channel Plugin отклоняет запросы с неверным токеном с HTTP 401.

## Reliability and Resilience

### NFR-003 HTTP client resilience

- При connect error или timeout Python bot уведомляет пользователя и предлагает выбрать другое окно.
- Ping перед выбором окна позволяет показывать только живые инстансы.

### NFR-004 Error propagation

- Любая ошибка доставки должна возвращаться пользователю без silent failure.
- Ошибка одного запроса не должна ломать пользовательскую сессию.

### NFR-005 Orphan cleanup

- Channel Plugin при старте удаляет stale registry entries с несуществующим PID.
- Python bot registry reader фильтрует stale entries по PID до ping.

## Compatibility

### NFR-006 Platform baseline

- Telegram bot: Python 3.11+, `python-telegram-bot >= 21.x`, `httpx >= 0.27`, `pyyaml >= 6.0`.
- Channel Plugin: Bun runtime (последний стабильный), `@modelcontextprotocol/sdk ^1.0`, `grammy ^1.21`.
- Claude Code: версия ≥ 2.1.80 (Channels research preview).

### NFR-007 Multimodal support

- Если Claude Code не поддерживает image content в channel notification — бот должен явно уведомить пользователя об этом ограничении.

## Performance and UX Constraints

### NFR-008 Message size limits

- Telegram ответы длиннее 4096 символов должны разбиваться на части без повреждения форматирования.

### NFR-009 Request timeout

- Таймаут HTTP POST /message (connect + send): 10 секунд.
- Таймаут GET /ping: 5 секунд (настраивается в конфиге).
- Claude Code обрабатывает запрос в своей сессии; bot не блокируется в ожидании ответа.

### NFR-010 Port selection

- Channel Plugin при занятом порту последовательно пробует 3100, 3101, 3102… и сохраняет финальный в реестре.

## Operational Constraints

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Channels research preview | Возможны breaking changes в MCP protocol | Следить за Claude Code changelog, фиксировать версию |
| Telegram rate limits | Частые sendMessage могут вызвать 429 | Экспоненциальный backoff при 429 в grammy |
| Один polling per bot token | Нельзя запускать несколько getUpdates одновременно | Поллинг только в Python bot; plugin только отправляет |
| Windows firewall | Bun HTTP server может быть заблокирован | Добавить исключение для bun.exe |
