# Channel Plugin Design

## Purpose

Channel Plugin — MCP-сервер, запускаемый Claude Code как subprocess (stdio). Он является точкой входа сообщений из Telegram в Claude Code Chat и точкой выхода ответов обратно в Telegram. Основан на официальном плагине `claude-plugins-official/external_plugins/telegram`, адаптированном для multi-window роутинга.

## Technology Stack

- Language: TypeScript
- Runtime: Bun
- MCP: `@modelcontextprotocol/sdk`
- Telegram: `grammy` (только отправка; polling — на стороне Python bot)
- HTTP server: встроенный Bun HTTP (`Bun.serve`)

## Planned Structure

```text
channel-plugin/
├── package.json
├── server.ts          ← точка входа: MCP stdio + HTTP listener
├── http-handler.ts    ← обработка POST /message и GET /ping
├── channel.ts         ← отправка MCP notifications/claude/channel
├── reply-tool.ts      ← реализация reply tool (отправка в Telegram)
├── registry.ts        ← регистрация в bot.db (instances) + heartbeat
└── config.ts          ← чтение конфигурации
```

## Configuration

Claude Code настраивает плагин через MCP server entry в `settings.json`:

```json
{
  "mcpServers": {
    "tg-bridge": {
      "command": "bun",
      "args": ["run", "/path/to/channel-plugin/server.ts"],
      "env": {
        "TG_BOT_TOKEN": "...",
        "TG_BRIDGE_PORT": "3100",
        "TG_BRIDGE_AUTH_TOKEN": "secret",
        "TG_BRIDGE_INSTANCE_NAME": "main"
      }
    }
  }
}
```

| Переменная | Описание |
|------------|----------|
| `TG_BOT_TOKEN` | Telegram bot token (только для sendMessage, не для polling) |
| `TG_BRIDGE_PORT` | Порт локального HTTP listener; если занят — автоподбор следующего |
| `TG_BRIDGE_AUTH_TOKEN` | Общий секрет для авторизации запросов от Python bot |
| `TG_BRIDGE_INSTANCE_NAME` | Имя инстанса для реестра (по умолчанию — имя текущей папки) |
| `TG_API_ROOT` | Bot API endpoint. Дефолт `https://api.telegram.org` (cloud, кап 20MB download / 50MB upload). `http://127.0.0.1:8081` → локальный telegram-bot-api, кап ~1990MB. Управляет `API_IS_LOCAL` в `config.ts` |
| `TG_BOTAPI_DOCKER` | Команда запуска docker для локального Bot API (дефолт `wsl docker`); нужна для `docker cp` входящих файлов из контейнера |
| `TG_BOTAPI_CONTAINER` | Имя контейнера telegram-bot-api (дефолт `telegram-bot-api`) |

> ⚠️ **Конфиг tg-bridge живёт в ТРЁХ скоупах, и они умеют разъезжаться** (см. инцидент 2026-05-22 в `plan/progress/`):
> 1. `tg-vscode-copilot/.mcp.json`
> 2. `tg-vscode-copilot/.claude/settings.json` — **перетирает** `.mcp.json` для окна tg-vscode-copilot.
> 3. Глобальный `~/.claude.json` → `mcpServers.tg-bridge` — его берут **все прочие окна**, у которых нет своего `.mcp.json`.
>
> Все окна запускают один и тот же `channel-plugin/server.ts`, но `env` каждое тянет из своего скоупа. При изменении env (endpoint, токены, порты) правьте **все три**. После правки нужен reload окна / рестарт MCP-сервера — живой процесс держит старый env в памяти.

## HTTP Endpoint

Plugin поднимает `Bun.serve` на `127.0.0.1:{port}`.

### POST /message

Принимает сообщение от Python bot и передаёт в Claude Code.

```typescript
// Request
{
  request_id: string;       // UUID для корреляции
  chat_id: number;          // Telegram chat ID для ответа
  user_id: number;          // Telegram user ID
  message_id: number;       // ID входящего сообщения (для reply threading)
  text: string;
  image?: { data: string; mime_type: string };  // base64, опционально
}

// Response: 202 Accepted
{ status: "queued" }

// Authorization: Bearer {auth_token} в заголовке
```

### GET /ping

Проверка доступности для Python bot.

```typescript
// Response: 200 OK
{ status: "ok", instance_name: string, workspace: string }
```

## MCP Tools Exposed to Claude

### `reply`

```typescript
{
  chat_id: number;   // кому отвечать
  text: string;      // текст ответа (Telegram MarkdownV2)
  reply_to?: number; // message_id для threading (опционально)
}
```

Plugin отправляет `text` напрямую в Telegram через `grammy` bot instance с форматированием `MarkdownV2`.

### `react`

```typescript
{ chat_id: number; message_id: number; emoji: string }
```

Добавляет emoji-реакцию (из approved Telegram set) на входящее сообщение.

### `download_attachment`

```typescript
{ file_id: string }   // attachment_file_id из входящего <channel> тега
// → возвращает локальный путь в ~/.tg-bridge-channel/inbox/
```

Фото обычно приходят как `image_path` (готовый путь). Не-image вложения (и иногда фото) приходят как `attachment_file_id` — тогда Claude вызывает `download_attachment`, чтобы вытащить файл в inbox, затем `Read`-ает его.

В `--local` режиме `getFile` возвращает путь **внутри контейнера** telegram-bot-api, а контейнер крутится в Docker с named-volume — хост не может прочитать файл напрямую. Поэтому плагин копирует файл из контейнера через `docker cp` (`TG_BOTAPI_DOCKER` + `TG_BOTAPI_CONTAINER`). Новые сборки telegram-bot-api возвращают `file_path` относительно `<dir>/<bot-token>/`, поэтому относительные пути резолвятся против `TG_BOTAPI_WORKDIR`.

## Attachments & File Size Limits

`MAX_ATTACHMENT_BYTES` (`src/bot-api.ts`) = `(API_IS_LOCAL ? 1990 : 50) * 1024 * 1024`.

| Endpoint | Download cap | Upload cap (`reply` files) |
|----------|--------------|----------------------------|
| Cloud (`api.telegram.org`) | 20 MB | 50 MB |
| Local (`127.0.0.1:8081`) | ~1990 MB | ~1990 MB |

`reply` проверяет размер каждого файла против `MAX_ATTACHMENT_BYTES` ещё **до** отправки и бросает `file too large: ... (X MB, max Y MB)`. Если `TG_API_ROOT` не доехал до запущенного процесса (см. ⚠️ про три скоупа выше), кап остаётся 50MB даже при поднятом локальном сервере — классический симптом рассинхрона конфига.

## Runtime Flow

1. Claude Code запускает `server.ts` как MCP subprocess (stdio).
2. Plugin поднимает HTTP listener и регистрируется строкой в таблице `instances` в `~/.tg-copilot-bridge/bot.db` (SQLite WAL), затем heartbeat'ит её каждые 15с.
3. Python bot обнаруживает плагин через реестр, пингует `GET /ping`.
4. Пользователь пишет в Telegram → Python bot делает `POST /message`.
5. Plugin оборачивает сообщение и отправляет `notifications/claude/channel` в Claude Code.
6. Claude Code получает сообщение, генерирует ответ.
7. Claude вызывает `reply` tool → plugin вызывает `grammy` sendMessage → Telegram.
8. Параллельно Claude может вызвать `react` чтобы поставить ✅ на входящее.

## Registry Entry

При старте plugin вставляет строку в таблицу `instances` базы
`~/.tg-copilot-bridge/bot.db` (см. `src/registry.ts` + `src/routes-db.ts`;
старый файловый реестр `instances/*.json` упразднён):

| column | значение |
|--------|----------|
| `id` | случайный hex на процесс |
| `host`, `port` | HTTP endpoint плагина |
| `auth_token` | Bearer для входящих POST |
| `instance_name`, `workspace_name` | имя инстанса / basename launch-cwd |
| `cwd` | канонический launch-cwd (`canonicalCwd`, верхний регистр диска) — ключ topic-binding'а |
| `pid`, `parent_pid` | плагин / родительский claude (parent_pid — якорь для хуков) |
| `started_at` | start-time-токен процесса (PID-reuse-proof liveness) |
| `heartbeat_at` | обновляется каждые 15с |

При остановке строка удаляется; stale-строки (heartbeat >45с и
PID мёртв/переиспользован по start-time) бот реапит сам.

## Differences from Official Plugin

| Official Plugin | This Plugin |
|----------------|-------------|
| Поллит Telegram самостоятельно | Только отправляет; polling в Python bot |
| Один инстанс, одна сессия | Один инстанс на окно VSCode |
| Pairing / allowlist внутри плагина | Allowlist в Python bot (`allowed_users`) |
| Нет HTTP endpoint | HTTP endpoint для приёма от Python bot |
| Нет регистрации в реестре | Регистрируется в `bot.db` (`instances`) с heartbeat |

## Operational Notes

- Требует Claude Code ≥ 2.1.80 (Channels research preview).
- При конфликте портов плагин перебирает 3100, 3101, 3102… и сохраняет финальный порт в реестре.
- Логи выводятся в stderr (Claude Code их захватывает в Output Channel).
