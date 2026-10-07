# Architecture Decision Records

В этой папке хранятся зафиксированные архитектурные решения.

## Именование
- `adr-0001-short-title.md`
- `adr-0002-short-title.md`

## Рекомендуемая структура
- `Status`
- `Context`
- `Decision`
- `Consequences`
- `Alternatives Considered`

Один ADR фиксирует одно решение и его последствия.

## Записи
- [adr-0002-no-proxy-over-chat-response-stream.md](adr-0002-no-proxy-over-chat-response-stream.md) — безопасное оборачивание `vscode.ChatResponseStream` (отказ от наивного `Proxy`).
- [adr-0003-stable-instance-dedup.md](adr-0003-stable-instance-dedup.md) — при двух живых окнах на одну папку дедуп выбирает инстанс стабильно по `started_at`, а не по свежести heartbeat (чинит флип-флоп маршрутизации «сообщения доходят через раз»).