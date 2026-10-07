# Runbook: плагины-сироты и перепривязка топиков

Накоплено из живых инцидентов 2026-07-05…07 (мак). Оба сценария до v1 доски
чинятся руками — здесь точные рецепты.

## Сирота съедает входящие (EPIPE)

**Симптом:** сообщение в топик «уходит», но окно его не видит; в
`~/.tg-bridge-channel/debug.log` — `sending notification …` и следом
`uncaught exception: Error: EPIPE: broken pipe, write`.

**Механика:** claude умер (краш, `--continue` без сессии, закрытие терминала),
а его channel-plugin (bun) выжил, переродителился к launchd (PPID=1) и
продолжает слать heartbeat. Бот считает окно живым и роутит в него; MCP-труба
плагина ведёт в мёртвый процесс → EPIPE, сообщение теряется молча. Типичный
кейс: **упавший первый запуск + успешный второй** = два инстанса с одним
именем, бот роутит в первый (мёртвый).

**Диагноз:**

```bash
# реестр: кто зарегистрирован
python3 -c "import json; d=json.load(open('$HOME/.tg-bridge-channel/instances.json')); \
  [print(v['port'], v['instance_name'], 'pid', v['pid'], 'ppid', v['parent_pid']) for v in d.values()]"
# сироты: bun-плагины с PPID=1 или мёртвым parent_pid
ps -axo pid,ppid,command | grep 'channel-plugin/server.ts' | grep -v grep
```

**Лечение:** `kill -TERM <pid сироты>`; если строка осталась в
instances.json — удалить её вручную (плагин, убитый до graceful shutdown, не
дерегистрируется). Бот подхватит на следующем тике.

**Автоматизация:** демон `agent/` уже детектит сирот (`GET /v1/status` →
`orphans[]`); в v1 доски — алерт + kill одной кнопкой (FR-401/404).

## Перепривязать окно к другому форум-топику

Топики ключуются по **cwd** (`resolve_workspace_id`), поэтому один и тот же
проект на разных машинах получает РАЗНЫЕ топики (виндовый путь к папке ≠
маковский путь к ней же). Если хочется, чтобы окно новой машины писало
в старый топик — перепривязка в bot.db на хосте бота (bot-host):

```bash
ssh bot-host 'docker exec tg-bridge-bot python -c "
import sqlite3, os
con = sqlite3.connect(os.path.expanduser(\"~/.tg-copilot-bridge/bot.db\"))
con.execute(\"update window_topics set message_thread_id=<СТАРЫЙ_THREAD>, icon_emoji=NULL, status=NULL where workspace_id=?\",
            (\"<CWD ОКНА>\",))
con.commit()"'
```

- `message_thread_id` — из ссылки на топик (`t.me/c/<chat>/<thread>`).
- `icon_emoji`/`status` сбросить в NULL — бот выставит заново на тике.
- Несколько workspace_id МОГУТ делить один thread (прецедент: один проект,
  открытый на маке и на винде, в одном топике) — inbound-роутинг забирает
  живое окно.
- Осиротевший автосозданный топик удалить через API бота:
  `deleteForumTopic?chat_id=<chat>&message_thread_id=<новый>` (бот — админ с
  Manage Topics; токен и `api_base_url` — в `/app/config.yaml` контейнера).
- Рестарт бота не нужен: storage читается из sqlite на каждом обращении.

## Сопутствующие факты (чтобы не переоткрывать)

- **`--continue` без локальной сессии роняет claude** — лаунчер
  `clients/polydaemon-claude.sh` с 2026-07-07 добавляет флаг только если есть
  `~/.claude/projects/<encoded-cwd>/*.jsonl` (encoding: не-алфанум → `-`).
- **Виндовые окна шлют `instance_name='main'`** (видно в bot.db) — поэтому
  реестр ключуется по workspace_name; чинить на виндовой стороне до
  возвращения приоритета instance_name (см. revert dbe7293).
- **Виндовые воркспейсы живут и во вложенных папках**, не только прямо в
  корне воркспейсов — cwd окна смотреть в `instances` bot.db, не угадывать.
- **Копирование спейсов по SMB:** родной маковский rsync 2.6.9 не годится
  (полчаса строит file-list) — `brew install rsync` (3.x, инкрементальный,
  `--partial`). `.venv` не копируется (симлинки под другую ОС) и не нужен.
- **CI-деплой бота на каждый пуш в main** гасит команды, попавшие в окно
  рестарта (~30с): «/launch не сработал» первым делом сверить с временем
  последнего пайплайна.

## Пин рантайма Bun (2026-07-10)

Bun переезжает с Zig на Rust; pre-release аудит порта — 13k+ unsafe-блоков и
UB-баги (bun.com/bun-unsafe-audit), а порт уже тянут в релизы. Вся сантехника
моста (channel-plugin, agentd) живёт на Bun, поэтому:

- **mac**: `brew pin bun` (закреплён 1.3.14); апгрейд — только осознанно:
  `brew unpin bun && brew upgrade bun && <прогнать смоук моста> && brew pin bun`.
- **agentd** на старте сверяет `Bun.version` с ожидаемой веткой (1.3.x) и
  громко ворнит в лог при несовпадении (`EXPECTED_BUN_MAJOR_MINOR` в agentd.ts).
- **Windows**: bun ставился не через brew — при обновлении руками держаться
  1.3.x, пока Rust-порт не отлежится.
