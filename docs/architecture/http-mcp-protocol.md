# HTTP + MCP Protocol

## Scope

Документ описывает два уровня взаимодействия:
1. **HTTP** — между Python bot и Channel Plugin (локальный транспорт).
2. **MCP** — между Channel Plugin и Claude Code (stdio, MCP spec).

Прежний WebSocket протокол (websocket-protocol.md) заменён этим документом.

---

## Layer 1: HTTP (Python Bot → Channel Plugin)

### Transport Assumptions

- Channel Plugin слушает `127.0.0.1:{port}` (только localhost).
- Python bot читает `port` и `auth_token` из таблицы `instances` в `~/.tg-copilot-bridge/bot.db`.
- Авторизация — Bearer token в заголовке `Authorization`.
- Корреляция запросов — по `request_id` (UUID v4).

### POST /message

```
POST /message HTTP/1.1
Host: 127.0.0.1:3100
Authorization: Bearer {auth_token}
Content-Type: application/json

{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "chat_id": 123456789,
  "user_id": 123456789,
  "message_id": 42,
  "text": "текст сообщения пользователя",
  "image": {
    "data": "<base64>",
    "mime_type": "image/jpeg"
  }
}
```

Поле `image` опционально. Python bot не ждёт завершения ответа Claude — запрос fire-and-forget.

**Ответ:**
```
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "status": "queued" }
```

**Ошибки:**

| Код | Причина |
|-----|---------|
| 401 | Неверный или отсутствующий `auth_token` |
| 503 | Plugin ещё не готов (MCP не поднят) |

### GET /ping

```
GET /ping HTTP/1.1
Host: 127.0.0.1:3100
Authorization: Bearer {auth_token}
```

**Ответ:**
```json
{ "status": "ok", "instance_name": "main", "workspace": "my-project" }
```

Python bot использует ping для построения списка живых окон перед показом `/window` keyboard.

---

## Layer 2: MCP (Channel Plugin → Claude Code)

Channel Plugin общается с Claude Code через MCP stdio transport согласно спецификации MCP.

### Инициализация

Plugin объявляет capability `experimental["claude/channel"]` в ответе на `initialize`:

```json
{
  "capabilities": {
    "experimental": {
      "claude/channel": {}
    }
  }
}
```

### Входящее сообщение (Plugin → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/claude/channel",
  "params": {
    "content": [
      { "type": "text", "text": "текст сообщения пользователя" }
    ],
    "meta": {
      "source": "telegram",
      "chat_id": 123456789,
      "message_id": 42,
      "user_id": 123456789
    }
  }
}
```

Для изображений content включает дополнительный элемент:
```json
{ "type": "image", "data": "<base64>", "mimeType": "image/jpeg" }
```

### Исходящий ответ: `reply` tool

Claude Code вызывает tool `reply` для отправки ответа:

```json
{
  "name": "reply",
  "arguments": {
    "chat_id": 123456789,
    "text": "Ответ Claude в формате Telegram MarkdownV2",
    "reply_to": 42
  }
}
```

Plugin при получении вызывает Telegram Bot API (`sendMessage`) и возвращает tool result:
```json
{ "sent": true, "telegram_message_id": 99 }
```

### `react` tool

```json
{
  "name": "react",
  "arguments": {
    "chat_id": 123456789,
    "message_id": 42,
    "emoji": "✅"
  }
}
```

---

## Sequence Diagram

```
Python Bot          Channel Plugin (HTTP)      Channel Plugin (MCP)       Claude Code
    │                       │                          │                       │
    │── POST /message ──────►│                          │                       │
    │◄── 202 Accepted ───────│                          │                       │
    │                        │── notifications/ ────────►│                       │
    │                        │    claude/channel         │── channel message ────►│
    │                        │                          │                       │ (думает)
    │                        │                          │◄── reply tool call ───│
    │◄── sendMessage ────────│◄── tool result request ──│                       │
    │  (Telegram API)        │── tool result ───────────►│                       │
    │                        │                          │                       │
```

---

## Keep-Alive / Health

Python bot периодически пингует все known instances через `GET /ping`. Инстансы, не отвечающие за 5 секунд, помечаются offline и не показываются в `/window` keyboard.
