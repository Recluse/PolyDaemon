# WebSocket Protocol

## Scope

Протокол определяет обмен сообщениями между Python bot и VSCode extension. Все сообщения передаются как JSON поверх WebSocket.

## Transport Assumptions

- Extension слушает локальный `host` и `port`, заданные в настройках VSCode.
- Бот открывает соединение к нужному инстансу по имени из своего конфига.
- Все запросы от бота должны содержать `token` для авторизации.
- Корреляция выполняется по `request_id`.

## Request Message

```typescript
interface RequestMessage {
  type: "chat";
  request_id: string;
  token: string;
  messages: ChatMessage[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  data: string;
  mime_type: string;
}

type ContentPart = TextPart | ImagePart;
```

## Response Messages

```typescript
interface ChunkMessage {
  type: "chunk";
  request_id: string;
  text: string;
}

interface DoneMessage {
  type: "done";
  request_id: string;
}

interface ErrorMessage {
  type: "error";
  request_id: string;
  message: string;
}
```

## Keep-Alive

Бот может отправить:

```json
{ "type": "ping", "token": "..." }
```

Extension должен ответить:

```json
{ "type": "pong", "instance_name": "main", "model": "copilot-gpt-4o" }
```

Кроме JSON ping/pong extension также должен корректно отвечать на стандартные WebSocket ping frames.

## Streaming Rules

- Каждый фрагмент текстового ответа отправляется как `ChunkMessage`.
- После завершения стрима extension обязан отправить `DoneMessage`.
- При любой ошибке extension обязан вернуть `ErrorMessage` с тем же `request_id`.
- Бот должен считать ответ завершенным только после `DoneMessage` или `ErrorMessage`.

## Media Handling

- Изображения передаются как `ImagePart` внутри `content`.
- Если мультимодальная поддержка в `vscode.lm` недоступна, extension должен использовать fallback и явно логировать деградацию поведения.