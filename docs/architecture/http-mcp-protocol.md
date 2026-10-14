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

### GET /tasks

Read-only snapshot of cross-window tasks addressed to this plugin's own window.
Requires the same Bearer authentication as `/status`. No caller-supplied window
selector is accepted; query parameters cannot change the scope.

```json
{
  "ok": true,
  "tasks": [{"id": 7, "from": "other-window", "kind": "tell", "text": "Review tests", "state": "running"}]
}
```

An upstream error or invalid task response returns HTTP 503 with
`{"ok":false,"tasks":null,"reason":"Tasks unavailable"}`. Only a successful
response with `tasks: []` means there are no tasks. Older plugins return 404;
clients must show unavailable, not an empty list. This endpoint does not drain
messages, resolve approvals or change task state.

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

## Pending Prompt Reminders

After three new ordinary messages in the same forum topic, the owning plugin
reposts each still-pending approval, question or plan card. All request cards
and reminders are excluded from the count, as are edits, callbacks, duplicate
message events and failed sends. A gap in Telegram message IDs is not a count.
The original request ID and deadline remain unchanged; all copies address the
same resolver. A reminder is never an approval.

The bot observes its successful sends through PTB's API callback wrapper and
authorized incoming messages. Plugins observe their successful sends and report
ordinary topic messages to authenticated `POST /topic-message` on the registry.
The registry forwards authenticated `POST /topic-activity` to live processes in
that topic, including siblings with separate pending requests. Both endpoints
carry only `{chat_id, message_thread_id, message_id}`. They never carry a decision
or message content. Local-only plugins notify live siblings directly.

The plugin filters events against each prompt's exact chat/topic and message ID.
Network failures do not change window health or resolve requests. Reminder
failure is retried on a subsequent ordinary message, not in an immediate loop.
Both bot and plugins need the updated implementation for remote topic coverage.
