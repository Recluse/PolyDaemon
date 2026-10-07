# Configuration Reference

Сводный справочник по всем поверхностям конфигурации PolyDaemon: конфиг бота,
env-переменные плагина, три места MCP-конфига, файлы permission-override и
runtime-состояния, а также запуск claude с бриджем.

> Все примеры здесь — плейсхолдеры. Реальные токены, приватные IP и chat_id
> в репозиторий не попадают (см. gitignore для `config.yaml`).

---

## 1. Bot config — `tg-bot/config.yaml`

Реальный `config.yaml` в `.gitignore`; форма берётся из
`tg-bot/config.yaml.example`. YAML, две секции: `telegram` и `bot`.

### `telegram`

| Ключ | Тип | По умолчанию | Назначение |
|------|-----|--------------|------------|
| `bot_token` | string | — | Токен от [@BotFather](https://t.me/BotFather). Хранится ТОЛЬКО в `config.yaml` (gitignored), не коммитить. |
| `api_base_url` | string (URL) | `http://127.0.0.1:8081` | Эндпоинт Bot API. Cloud — `https://api.telegram.org`; self-hosted — адрес твоего `telegram-bot-api` (см. ниже). |
| `use_local_bot_api` | bool | `true` | Включает self-hosted-режим. `false` → откат на облако. |
| `forum_chat_id` | int | `-100…` | Супергруппа-форум для топиков-на-окно. Пусто/0 = фича выключена (только приватный чат). |
| `allowed_users` | int[] | `[]` | Whitelist по Telegram user ID. Пустой `[]` = разрешить всем. |

**Cloud vs self-hosted.** Облачный API (`https://api.telegram.org`) лимитирует
файлы: **download 20MB / upload 50MB**. Собственный сервер `telegram-bot-api`
поднимает это до **~1990MB**. Эндпоинт генерический — укажи его туда, где у тебя
крутится `telegram-bot-api` (локально на этой машине, в Docker, или на удалённом
хосте через SSH-туннель). Чтобы вернуться на облако — `use_local_bot_api: false`.

**Как получить `forum_chat_id`.** Создай группу → включи **Topics** в настройках
группы → добавь бота админом с правом **Manage Topics** → выполни в группе
команду `/chatid` → вставь полученный `-100…` id в конфиг.

### `bot`

| Ключ | Тип | По умолчанию | Назначение |
|------|-----|--------------|------------|
| `ping_timeout` | float (s) | `5.0` | Таймаут ping-запроса к плагину окна. |
| `post_timeout` | float (s) | `10.0` | Таймаут на доставку сообщения в плагин. |
| `default_instance` | string | `""` | Дефолтное окно для DM-роутинга, когда активное не выбрано. Пусто = нет. Глобальный override через Settings → «🪟 Дефолтное окно» (`default-instance.json`) имеет приоритет. |
| `instance_poll_interval` | float (s) | `3.0` | Период пересканирования таблицы `instances` в `bot.db`. При изменении бот пушит новую клавиатуру allowed-юзерам. `0` = отключить. |

---

## 2. Channel-plugin env

Плагин (`channel-plugin/`, Bun/TypeScript) читает конфиг из env или из
`~/.tg-bridge-channel/.env` (формат `KEY=value`, права файла принудительно
`0600`; env имеет приоритет над `.env`). Источник — `channel-plugin/src/config.ts`.

| Env | Обязателен | По умолчанию | Назначение |
|-----|------------|--------------|------------|
| `TG_BOT_TOKEN` | да | — | Токен бота. Без него плагин падает на старте. |
| `TG_BRIDGE_AUTH_TOKEN` | да | — | Shared-secret между ботом и плагином (HTTP-авторизация). Без него плагин падает. |
| `TG_BRIDGE_INSTANCE_NAME` | нет | basename(cwd) | Имя инстанса/окна. По умолчанию — имя папки воркспейса. |
| `TG_BRIDGE_PORT` | нет | `3100` | Стартовый порт локального HTTP-сервера плагина (далее ищется свободный вверх). |
| `TG_BRIDGE_FORCE_CHANNELS` | нет | — | `1` = окно запущено с каналами, проверять не нужно. Лаунчеры (`polydaemon-claude.sh`, `polydaemon-claude.cmd`) ставят сами; без него плагин смотрит командную строку родителя (на Windows — через WMI, которая может подвиснуть). |
| `TG_API_ROOT` | нет | `https://api.telegram.org` | Эндпоинт Bot API для плагина. Любое значение ≠ облака → `API_IS_LOCAL=true` (local-режим). Trailing-слэши срезаются. |
| `TG_BOTAPI_DOCKER` | нет | `wsl docker` | Команда docker-CLI для `docker cp` из контейнера, когда `telegram-bot-api` локален. |
| `TG_BOTAPI_CONTAINER` | нет | `telegram-bot-api` | Имя docker-контейнера `telegram-bot-api`. |
| `TG_BOTAPI_SSH` | нет | `""` | SSH-таргет (например `bot-host` из `~/.ssh/config`), когда сервер на ДРУГОМ хосте. Пусто = сервер локален, используется `docker cp`. |
| `TG_BOTAPI_WORKDIR` | нет | `/var/lib/telegram-bot-api` | Значение `--dir` сервера. Новые сборки возвращают `getFile.file_path` ОТНОСИТЕЛЬНО `<dir>/<bot-token>/`; плагин резолвит относительные пути от этой базы. Trailing-слэши срезаются. |

### Приём файлов в local-bot-api режиме

В `--local`-режиме `getFile` возвращает не URL, а **путь на файловой системе
сервера** (а сервер обычно в Docker с named-volume, так что хост не читает его
напрямую). Плагин достаёт байты одним из двух путей:

- **Сервер локален** (`TG_BOTAPI_SSH` пуст): `docker cp` из контейнера —
  `<TG_BOTAPI_DOCKER> cp <TG_BOTAPI_CONTAINER>:<path> …`.
- **Сервер на удалённом хосте** (`TG_BOTAPI_SSH=<host>`): getFile отдаёт
  in-container путь, недоступный отсюда. Плагин стримит байты через
  `ssh <host> docker exec <container> cat <path>`. SSH-юзер должен быть в
  группе `docker` на удалённом хосте.

Относительные `file_path` резолвятся от `TG_BOTAPI_WORKDIR` перед передачей в
`docker cp` / `docker exec cat`.

---

## 3. Три места MCP-конфига (ВАЖНАЯ гоча)

> ⚠️ Env MCP-сервера `tg-bridge` может жить в ТРЁХ местах. Они **обязаны
> совпадать**. Дрейф здесь уже приводил к реальному багу (50MB-cap: одно место
> осталось на облачном API, файлы резались на 50MB вместо ~1990MB).

| Место | Путь | Область действия |
|-------|------|------------------|
| Project `.mcp.json` | `<workspace>/.mcp.json` | Конфиг MCP-серверов для конкретного воркспейса (коммитится в репо). |
| Project settings | `<workspace>/.claude/settings.json` | Project-scoped настройки/env Claude Code. |
| **Global** | `~/.claude.json` | **Авторитетный** для всех воркспейсов, у которых нет локального override. Именно отсюда tg-bridge стартует в чужих воркспейсах. |

Глобальный `~/.claude.json` — источник истины для не-project-воркспейсов: имя
сервера `tg-bridge` со всеми env (`TG_BOT_TOKEN`, `TG_BRIDGE_AUTH_TOKEN`,
`TG_API_ROOT`, `TG_BOTAPI_*` и т.д.) прописано там. При правке env tg-bridge —
проверяй все три места на синхронность.

(Имена ключей описаны; реальные значения токенов сюда не выносятся.)

---

## 4. Permission overrides — `~/.tg-copilot-bridge/permission-overrides.json`

JSON `{ workspace_name: mode }`. Пишется меню `/permissions` бота, читается
плагином и хуком `tg-approve`. Канонический список режимов — в
`tg-bot/bot/permissions.py`.

| Mode (canonical) | Label | Поведение |
|------------------|-------|-----------|
| `default` | 🤔 Ask before edits | Спрашивает через Telegram/VSCode перед действиями. |
| `acceptEdits` | ⚡ Edit automatically | Авто-разрешение Edit/Write — спрашивает только Bash и опасное. |
| `plan` | 📋 Plan mode | Только план, без исполнения. |
| `auto` | 🪄 Auto mode | Claude сам выбирает режим под задачу. |
| `bypassPermissions` | 🔓 Bypass permissions | Никогда не спрашивает — выполняет всё подряд. |

Заметки по семантике:

- Ключи режимов совпадают с `permissionMode` Claude Code — их можно использовать
  verbatim.
- **Live-применяется только `bypassPermissions`.** Остальные режимы хранятся как
  предпочтение, но реально вступают в силу только когда тот же режим выставлен в
  Claude Code UI соответствующей сессии.
- `default` не хранится в файле — отсутствие записи = `default`. Запись
  `default` удаляется при сохранении.
- Легаси-значения `ask`/`bypass` авто-мигрируются в `default`/`bypassPermissions`
  при чтении.
- Bypass-проверка в `tg-approve.js` идёт ДО плагин-гейта: воркспейс с
  `bypassPermissions` авто-аллоу даже для standalone-claude.

---

## 5. Runtime state — `~/.tg-copilot-bridge/`

Шаренный каталог состояния между ботом и плагином (см. `tg-bot/bot/paths.py`,
`channel-plugin/src/config.ts`).

| Файл/папка | Назначение |
|------------|------------|
| `bot.db` | SQLite (WAL): `instances` (реестр окон), `window_topics` (топик↔воркспейс), `message_routes`, `sessions`. Пишут оба — бот и плагин; WAL не даёт им лочить друг друга. |
| `topic-bindings.json` | Проекция `window_topics` для плагина — читается при зеркалировании исходящих сообщений в форум-топики окна. Пишет бот. |
| `active-instances.json` | Активное окно каждого юзера. Плагин читает синхронно для DM-роутинга и кнопки «Ответить здесь» на кросс-оконных репликах. |
| `permission-overrides.json` | Режимы разрешений по воркспейсу (см. §4). |
| `default-instance.json` | Глобальный override дефолтного окна (Settings → «🪟 Дефолтное окно»); приоритетнее `config.yaml: bot.default_instance`. |
| `extension-endpoints/` | HTTP-эндпоинты VS Code-расширения (approve-UI). |

---

## 6. Запуск claude с бриджем — `polydaemon-claude.cmd`

Пер-воркспейсный лаунчер в корне воркспейса. Один и тот же файл работает в любой
папке — `--name` выводится из имени родительской папки, так что копируй его в
новый воркспейс как есть. Лишние аргументы (`%*`) пробрасываются в claude.

Передаваемые флаги:

```text
claude.cmd --dangerously-load-development-channels server:tg-bridge \
           --continue \
           --name "<имя папки>" \
           --permission-mode bypassPermissions %*
```

| Флаг | Назначение |
|------|------------|
| `--dangerously-load-development-channels server:tg-bridge` | Подключает MCP-сервер `tg-bridge` как dev-канал (inbound/outbound + хуки). |
| `--continue` | Возобновляет последнюю сессию воркспейса. |
| `--name "<имя папки>"` | Имя инстанса/окна = basename текущей папки (`%~nxI` от `%CD%`). |
| `--permission-mode bypassPermissions` | Стартовый permission-mode сессии. |

> ⚠️ **ASCII + CRLF обязательны.** `cmd.exe` (cp866) давится UTF-8 em-dash и
> LF-окончаниями — файл должен быть в чистом ASCII с CRLF. Это
> Windows-only-скрипт, поэтому CRLF здесь оправдан (общее правило проекта — LF).

Standalone `claude` без флага `--dangerously-load-development-channels` работает
как обычно: бридж и хуки не вмешиваются.

---

## См. также

- `docs/getting-started.md`, `docs/multi-machine.md` — установка на одной и на нескольких машинах.
- `docs/architecture/channel-plugin.md` — устройство плагина.
- `docs/architecture/telegram-bot.md` — устройство роутер-бота.
- `tg-bot/config.yaml.example` — шаблон конфига бота.
