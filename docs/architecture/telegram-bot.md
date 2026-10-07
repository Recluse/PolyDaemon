# Telegram Bot Design

## Purpose

Python Router Bot — единственная точка входа из Telegram. Он поллит обновления, обслуживает команды пользователя, хранит выбор активного окна и маршрутизирует сообщения в нужный Channel Plugin. Бот не управляет историей диалога — контекст хранит Claude Code внутри своей сессии.

## Technology Stack

- Python 3.11+
- `python-telegram-bot >= 21.x`
- `httpx >= 0.27` (async HTTP client для запросов к channel plugin)
- `pyyaml >= 6.0`

## Planned Structure

```text
tg-bot/
├── config.yaml
├── requirements.txt
├── tgbridge.py
├── bot/
│   ├── handlers.py
│   ├── session.py
│   └── keyboards.py
├── bridge/
│   ├── client.py        ← HTTP client для channel plugin
│   └── registry.py      ← чтение bot.db (instances) + liveness/dedup
└── utils/
    └── image_utils.py
```

## Configuration

```yaml
telegram:
  bot_token: "YOUR_BOT_TOKEN"
  allowed_users:
    - 123456789

bot:
  ping_timeout: 5.0
  default_instance: "main"
```

- `allowed_users`: whitelist по Telegram user ID; если список пуст — доступ открыт всем.
- `ping_timeout`: секунды ожидания при проверке доступности окна.
- Основной источник инстансов — таблица `instances` в `~/.tg-copilot-bridge/bot.db` (заполняется channel plugin'ами, heartbeat 15с). Статичный конфиг не нужен. Liveness: heartbeat < 45с — живой; иначе PID-probe со start-time-токеном (PID-reuse-proof), мёртвые строки реапятся.
- `api_base_url` / `use_local_bot_api`: при `true` бот ходит в self-hosted telegram-bot-api (у нас — Docker на bot-host через ssh-туннель `127.0.0.1:8081`), лимиты файлов ~1990MB.

## User Commands

| Command | Purpose |
|---------|---------|
| `/start` | Приветствие и краткая справка |
| `/help` | Справка по возможностям |
| `/window` | Выбор активного окна Claude Code |
| `/clear` | Сигнал Claude Code начать диалог заново (отправляет системное сообщение) |
| `/status` | Проверка доступности всех зарегистрированных инстансов |

## Session Model

```python
@dataclass
class UserSession:
    user_id: int
    active_instance: str   # ключ из реестра (instance_name)
    last_activity: datetime
```

Бот не хранит историю сообщений — это контекст Claude Code. Команда `/clear` отправляет в активный channel plugin специальный POST с `text = "__clear__"`, который plugin транслирует в Claude Code как системную инструкцию начать разговор заново.

## Message Handling

### Text Flow

1. Проверить доступ пользователя по `allowed_users`.
2. Взять или создать `UserSession`.
3. Отправить `typing` action в Telegram (индикатор обработки).
4. Найти активный instance в реестре; если недоступен — предложить выбрать другой.
5. `POST /message` к выбранному channel plugin (fire-and-forget, 202 Accepted).
6. Ответ придёт асинхронно: channel plugin сам вызовет Telegram `sendMessage`.

### Image Flow

1. Скачать изображение через Telegram API (`get_file` + download).
2. Определить MIME type.
3. Закодировать в base64.
4. `POST /message` с полем `image: { data, mime_type }` и `text` = caption (или пустая строка).

### Window Selection

Главная reply-keyboard — статическая: `[📊 Окна] [⚙️ Настройки]`. Тап
`📊 Окна` свапит reply-keyboard на quick-switch:
кнопки-окна (`display_name`-ы из реестра, уникифицированы через `[port]`-суффикс
при коллизии) + `[📈 Статус] [◀️ Назад]`. Список инстансов читается из
`bot.db` (`instances`) без пингов — pointer-only flow.

1. Тап `📊 Окна` → `refresh_instances` (DB + heartbeat/PID-фильтрация, без HTTP) →
   `build_window_quick_switch_keyboard` → swap reply-kbd.
2. Тап имени окна → `set_active_instance` + `persist_active_instances` +
   восстановление главной reply-kbd. Без пингов.
3. Тап `📈 Статус` → инлайн-список окон с current status (медленный путь
   с пингами через `build_window_options`). Picker reply-kbd остаётся.
4. Тап `◀️ Назад` → восстановление главной reply-kbd с маркером
   «🪟 Активное окно: {display_name}».

`/window` команда даёт инлайн-список со статусами (как `📈 Статус`) для
тех, кто привык к slash-командам.

### UI Message Lifecycle (трёхслотовый трекинг)

**Гочча Telegram:** удаление сообщения, несущего ReplyKeyboardMarkup,
снимает клавиатуру с клиента. Telegram не «прокручивает» обратно к
предыдущему message с reply-kbd — клиент тупо теряет состояние. Это
поведение клиента, не баг бота, и оно работает одинаково при `delete_message`
со стороны бота И при ручном удалении пользователем.

Поэтому в `messages.py` каждый reply-keyboard tap хендлер использует
трёхслотовое отслеживание UI-сообщений через `context.chat_data`:

| Слот | Несёт | Когда жив |
|------|-------|-----------|
| `MAIN_ANCHOR_MSG_KEY` | главная reply-kbd | в main-режиме |
| `PICKER_MSG_KEY` | picker reply-kbd | в picker-режиме |
| `AUX_MSG_KEY` | только инлайн (Настройки, статус-лист, статус-панель) | опционально |

Инвариант: ровно один из MAIN_ANCHOR / PICKER жив одновременно — в зависимости
от режима. AUX опциональный overlay поверх. Каждый tap чистит свой эхо-месседж
от пользователя через `delete_message` и заменяет соответствующие слоты.

Переходы:
- `📊 Окна` (main → picker): delete MAIN_ANCHOR + AUX → send PICKER.
- имя окна / `◀️ Назад` (picker → main): delete PICKER + AUX → send новый MAIN_ANCHOR.
- `⚙️ Настройки` (стой в main, открыть инлайн): keep MAIN_ANCHOR, replace AUX.
- `📈 Статус` (стой в picker, открыть инлайн): keep PICKER, replace AUX.

Order: всегда send-new-first, потом delete-old — иначе мгновение без
кбд-носителя в чате, клава флипает.

**Recovery после ручного удаления** anchor-сообщения: `/start` — он
переотправляет главную reply-kbd.

## HTTP Bridge Client

`bridge/client.py` реализует async HTTP client поверх `httpx`.

- Один клиент на процесс бота (shared session, keep-alive). ⚠️ Создаётся
  ЛЕНИВО при первом запросе (`_get_client()`): конструирование
  `httpx.AsyncClient` в sync `__init__` до `run_polling()` на
  Py 3.14 + anyio вешало первый async-запрос на ~25 минут.
- Таймаут на `POST /message`: 10 секунд (только connect + отправка; ответ Claude придёт отдельно).
- Таймаут на `GET /ping`: `ping_timeout` из конфига.
- При HTTP 401 — логировать и уведомить пользователя об ошибке auth.
- При HTTP 503 или connect error — instance помечается недоступным.
- Закрывается в `post_shutdown` (`aclose()`).

## Registry Reader

`bridge/registry.py` читает таблицу `instances` из `~/.tg-copilot-bridge/bot.db`.

- Канонизирует `cwd` (`canonical_cwd` — буква диска в верхний регистр,
  ОБЯЗАНА совпадать с `canonicalCwd` плагина).
- Liveness: свежий heartbeat (≤45с) — живой без PID-probe; иначе сравнение
  start-time-токена (PID-reuse-proof); мёртвые строки удаляются.
- Идентичность окна = `workspace_name` (не host:port — порты ротируются).
  При двух живых окнах одного воркспейса — стабильный победитель
  (later-started, tiebreak порт) + warning в лог.
- Результат — список `RuntimeInstance` с `key`, `display_name`, `host`,
  `port`, `auth_token`, `cwd`.
