# Claude Code Hooks Design

## Overview

tg-bridge встраивается в нативный диалог Claude Code не только через MCP-плагин,
но и через набор **Claude Code hooks** — внешних скриптов, которые Claude вызывает
на определённых событиях (`PreToolUse`, `Notification`, `Stop`). Хуки решают то,
что MCP-плагин в одиночку не может: перехватить запрос на разрешение тула,
вопрос `AskUserQuestion`, выход из plan-mode — и увести эти решения в Telegram,
вместо нативного IDE/TUI пикера.

Семь хуков, шесть из них — Node.js (`~/.claude/hooks/tg-*.js`), один — Bun/TS и
лежит **в репозитории** (`channel-plugin/hooks/pre-tool-use.ts`):

| Хук | Событие | Назначение |
|-----|---------|------------|
| `tg-bridge-locate.js` | — (shared helper) | `findOwnPlugin(cwd)` — поиск плагина ЭТОЙ claude в `bot.db` |
| `tg-approve.js` | PreToolUse (`*`) | Permission-промпты → Telegram inline keyboard |
| `tg-ask-question.js` | PreToolUse (`AskUserQuestion`) | Вопрос с вариантами → Telegram, блокирует IDE-пикер |
| `tg-exit-plan.js` | PreToolUse (`ExitPlanMode`) | План → Telegram с кнопками apply/decline |
| `tg-notify.js` | Notification | Зеркалит нативные диалоги (trust/MCP/settings) в топик окна |
| `tg-stop-mirror.js` | Stop | Safety net: финальный текст в Telegram, если забыли `reply` |
| `channel-plugin/hooks/pre-tool-use.ts` | PreToolUse (`*`) | Прогресс-сводка + narration в `/progress` для «⏳ Работаю...» |

> ⚠️ Шесть `tg-*.js`-хуков **НЕ лежат в репозитории**. Они физически живут в
> `~/.claude/hooks/` и должны копироваться туда вручную. В репо — только
> `pre-tool-use.ts`. См. раздел [Requirements & gotchas](#requirements--gotchas).

## The gate (plugin-presence)

Ключевой принцип: **хуки срабатывают ТОЛЬКО когда к этой claude прикреплён
tg-bridge channel plugin.** Standalone `claude` (запущенный без флага
`--dangerously-load-development-channels server:tg-bridge`) плагина не поднимает,
строки в реестре нет → хуки выходят молча → нативный flow Claude Code.

Это и есть «гейт» — он реализован общим helper'ом `tg-bridge-locate.js`,
функция `findOwnPlugin(cwd)`:

1. Открывает `~/.tg-copilot-bridge/bot.db` (`node:sqlite`, read-only) и читает
   таблицу `instances`, отфильтровав строки со свежим heartbeat
   (`heartbeat_at > now − 45с`, `HEARTBEAT_FRESH_SECONDS`), отсортированные по
   heartbeat DESC.
2. **Сперва** ищет строку, где `parent_pid === process.ppid` — точное
   совпадение, когда claude спавнит хук напрямую.
3. **Затем** (fallback) — **cwd walk-up**: берёт cwd тула (или `input.cwd`,
   переданный вызывающим), сравнивает его и каждую родительскую папку с `cwd`,
   записанным плагином при регистрации. Сравнение через `cmpForm` —
   нормализует слэши и регистр, чтобы `C:/x` и `c:\x` совпали. Самый глубокий
   совпавший предок выигрывает; среди равных-cwd строк побеждает самая свежая
   (список уже heartbeat-DESC).
4. Возвращает `{ host, port, auth_token, workspace_name, cwd, pid }` или `null`.

`null` означает одно из:
- DB-файла нет (бот ни разу не запускался);
- ни одна строка не совпала ни по `parent_pid`, ни по cwd → **это standalone
  claude** (строка в реестре есть только если плагин стартовал, а это бывает
  лишь при флаге `--dangerously-load-development-channels`);
- совпавшие строки протухли (heartbeat старше 45с — плагин упал, HTTP не отдаёт).

### Почему cwd walk-up, а не parent_pid

Тонкость: **claude спавнит хуки через shell-shim** (`cmd.exe` парсит строку
`node "...js"`), поэтому `process.ppid` хука — это PID шима, а НЕ claude.
Из-за этого совпадение по `parent_pid` в реальности почти всегда промахивается,
и **настоящий рабочий путь сопоставления — именно cwd walk-up.** `parent_pid`
оставлен первым в порядке проверки, потому что когда он всё-таки срабатывает
(claude спавнит хук напрямую) — совпадение однозначное.

Именно поэтому в каждом хуке `findOwnPlugin(input.cwd)` вызывается **после**
парсинга stdin: lookup'у нужен `input.cwd`, без него walk-up не с чего начать.

## Hook reference

### `tg-approve.js` — PreToolUse (permission-промпты)

**Событие:** `PreToolUse`, matcher `*` (любой тул).
**Назначение:** увести запрос на разрешение тула в Telegram inline keyboard
вместо нативного пикера.

Порядок принятия решения:

| # | Условие | Решение |
|---|---------|---------|
| 1 | `tool_name` начинается с `mcp__tg-bridge__` | `allow` (авто, чтобы не зациклить мост) |
| 2 | `input.permission_mode === 'bypassPermissions'` | `allow` (сессии нечего гейтить) |
| 3 | Workspace bypass-override совпал | `allow` |
| 4 | Нет плагина (`findOwnPlugin` → null) и нет override | `exit 0` (молча → нативный flow) |
| 5 | Гонка Telegram `/approve-request` против VS Code `/approve` | первое реальное allow/deny |

Шаги 1–2 проверяются **до** lookup'а плагина: они работают для любой claude с
override-файлом, даже standalone, чтобы Bypass-помеченный воркспейс
авто-разрешался независимо от того, поднят ли плагин.

**Bypass-override (шаг 3)** читается из `~/.tg-copilot-bridge/permission-overrides.json`.
Логика зависит от того, прикреплён ли плагин:
- **плагин есть** → точное совпадение по `target.workspace_name` (авторитетная
  идентичность воркспейса — ровно тот ключ, под которым бот пишет override).
  Это чинит старый баг over-match'а, когда тул под `<корень-воркспейсов>\<не-bypass-ws>`
  цеплял ключ корневой папки уровнем выше;
- **плагина нет** (standalone) → fallback `findOverrideUpTree(cwd)`: walk-up по
  дереву cwd, первый `basename`, для которого есть запись в override-файле.
  Это чинит саб-папочный баг (`<ws>\sourcecode\ref-data` → basename
  `ref-data` ≠ ключ `<ws>` → раньше был лишний «ask»).
  `isBypass()` принимает канонический `bypassPermissions` и legacy-алиас `bypass`.

**Гонка (шаг 5):** POST `/approve-request` к плагину (Telegram) запускается всегда;
дополнительно, если найден живой VS Code endpoint
(`~/.tg-copilot-bridge/extension-endpoints/`, отфильтрованный по `pidAlive` и
most-specific-workspace-prefix), к нему шлётся POST `/approve`. `firstRealDecision`
резолвит на ПЕРВОМ реальном `allow`/`deny`. Ключевая тонкость: dismissed
VS Code-диалог возвращает `"ignored"` → маппится в `null` (НЕ в deny!) → этот
ответчик выпадает из гонки, и решает Telegram. Таймаут гонки —
`APPROVAL_TIMEOUT_MS = 10 минут`.

**Failure fallback:** парсинг stdin упал → `ask`; ни один канал не вернул
решения → `ask`; исключение в гонке → `ask`. То есть любой сбой → нативный пикер.

### `tg-ask-question.js` — PreToolUse (`AskUserQuestion`)

**Событие:** `PreToolUse`, matcher `AskUserQuestion`.
**Назначение:** отрисовать вопрос и его варианты как Telegram inline keyboard,
заблокировав IDE-пикер.

После парсинга stdin — гейт `findOwnPlugin(input.cwd)`; нет плагина → `exit 0`.
Парсит `tool_input.questions` (поддержка нескольких вопросов, `multiSelect`,
`header`). К каждому вопросу принудительно добавляется `allowCustom: true` —
неявный «Other» Claude Code превращается в кнопку **«✍️ Свой ответ»** для
свободного текста. POST `/ask-question` к плагину (`APPROVAL_TIMEOUT_MS + 5000`).

Маппинг ответа плагина:

| `body.status` | Решение | reason для Claude |
|---------------|---------|-------------------|
| `answered` | `deny` | отформатированные ответы + «не вызывай AskUserQuestion снова» |
| `timeout` | `deny` | partial-ответы (если есть) + «считай неотвеченное неопределённым» |
| `fallback` | `ask` | → нативный пикер |
| `invalid` | `ask` | → нативный пикер |
| иное / HTTP≠200 | `ask` | → нативный пикер |

Хитрость: ответ пользователя отдаётся Claude **через `permissionDecision="deny"`
+ текст в `reason`** — `deny` блокирует IDE-пикер, а модель читает ответ из
reason как эффективный результат тула. `formatAnswer` явно разписывает
custom/multi/single-варианты.

**Failure fallback:** парсинг stdin, нет parsable-вопросов, сетевая ошибка,
неожиданный статус → `ask` (нативный пикер).

### `tg-exit-plan.js` — PreToolUse (`ExitPlanMode`)

**Событие:** `PreToolUse`, matcher `ExitPlanMode`.
**Назначение:** показать план в Telegram с кнопками apply/decline.

После парсинга stdin — гейт `findOwnPlugin`; нет плагина → `exit 0`. Пустой план
→ `ask`. POST `/exit-plan` с `{ plan, cwd }`.

| Ответ плагина | Решение | Эффект |
|---------------|---------|--------|
| `answered` + `decision: "apply"` | `allow` | Claude выходит из plan-mode, выполняет план |
| `answered` + `decision: "decline"` | `deny` | Claude остаётся в plan-mode, дорабатывает |
| `timeout` | `deny` | «план не одобрен, продолжай планировать» |
| `fallback` / HTTP≠200 / иное | `ask` | → нативный пикер |

**Failure fallback:** любая ошибка → `ask`.

### `tg-notify.js` — Notification

**Событие:** `Notification`, matcher `""` (любая нотификация).
**Назначение:** зеркалить **нативные диалоги** в Telegram-топик окна для
ВИДИМОСТИ.

Зачем: часть промптов — folder/workspace trust, MCP-server approval, settings
access — это нативные TUI-диалоги, которые `bypassPermissions` НЕ снимает и
которые PreToolUse-хуки вообще не видят (они показываются только в консоли).
`Notification`-хук — единственное событие, которое для них фаерится. Ответить на
них хук **не может** (Claude Code не разрешает), но может сказать пользователю
«это окно заблокировано, посмотри», и окно больше не висит молча.

Поведение:
- пустое сообщение → `exit 0`;
- сообщение матчит `/waiting for your input|waiting for input/i` → **подавляется**
  (`exit 0`): idle-нотификация «Ждёт ответа в консоли» фаерится на каждом
  завершении хода, но результат уже доехал до пользователя через `reply`/
  stop-mirror — это просто спам;
- иначе гейт `findOwnPlugin`; нет плагина → `exit 0`;
- POST `/notify` с `{ message, cwd, workspace_name }` (таймаут `NOTIFY_TIMEOUT_MS = 5с`).

**Failure fallback:** всегда `exit 0` (Notification-хуки информационные; сбой
моста никогда не должен блокировать Claude). stdout игнорируется.

### `tg-stop-mirror.js` — Stop

**Событие:** `Stop`, matcher `""`.
**Назначение:** safety net — гарантировать, что Telegram-ход всегда дойдёт до
пользователя.

Зачем: правило роутинга tg-bridge требует отвечать на Telegram-промпт через MCP-тул
`reply`. Но модель иногда пишет ответ в терминал (или только реагирует) и забывает
вызвать `reply` — пользователь в Telegram ничего не видит. Этот хук на завершении
хода: если последний человеческий промпт пришёл из Telegram И в этом ходе `reply`
не вызывался — постит финальный текст ассистента в `/auto-reply`.

Алгоритм:
1. Читает `transcript_path`, парсит JSONL-записи.
2. Находит последний human-промпт (`isHumanPrompt` — `user`-запись с реальным
   text-блоком, не tool_result-эхо). Всё после него — «этот ход».
3. Если в тексте промпта нет `source="telegram"` → `done` (консольный ход вне
   зоны действия). Из `chat_id="..."` извлекается chat_id.
4. Идёт по assistant-блокам хода: если вызывался `mcp__tg-bridge__reply` (или
   `*__reply`) → `done` (уже доставлено, без двойного поста).
5. «Ответ» = хвостовой ран text-блоков (закрывающее сообщение после последнего
   тула); ранний текст — mid-turn narration, не зеркалится. Пустой хвост → `done`.
6. Гейт `findOwnPlugin(input.cwd)`; нет плагина → `done`.
7. POST `/auto-reply` с `{ text, chat_id, cwd }` (таймаут `5с`).

**Failure fallback:** всегда `exit 0` (Stop-хук не должен блокировать Claude).
`reason` логируется в stderr только при `TG_STOP_MIRROR_DEBUG`.

### `channel-plugin/hooks/pre-tool-use.ts` — PreToolUse (прогресс + narration)

**Событие:** `PreToolUse`, matcher `""`. Единственный хук **в репозитории**
(Bun/TS, `bun:sqlite`).
**Назначение:** обновлять живой статус-месседж «⏳ Работаю...» в Telegram.

Делает две вещи и постит обе в `/progress`:
1. **Прогресс-сводка** (`buildSummary`): короткая строка вида `Bash: <cmd>`,
   `Edit <file>`, `Grep "<pattern>"`, `Task: <desc>` и т.п. Свои
   `mcp__tg-bridge__*`-тулы, `BashOutput`, `KillShell` пропускаются.
2. **Narration** (`readLatestNarration`): читает хвост транскрипта (последние
   `64KB`), находит последний assistant-text-блок и шлёт его как `narration`
   (в Telegram показывается строками 💭, обрезается до `280` символов). Это
   ближайшее к live-«thinking»: настоящие extended-thinking-блоки в транскрипте
   signature-only/пустые, а вот эта проза — то, что модель пишет между тулами.

Свой гейт через **`findInstance(cwd)`** (не общий helper — отдельная реализация
на `bun:sqlite`): матчит строку `instances` по точному cwd (нормализованному),
heartbeat ≤45с, без VS Code-специфичной проверки. Нет плагина → null → no-op.
Если нет ни сводки, ни narration — даже не лезет в БД. POST `/progress`
с `AbortController` и `POST_TIMEOUT_MS = 800мс`.

**Failure fallback:** best-effort, любая ошибка проглатывается — тул-колл никогда
не падает из-за того, что статус-эдит не доехал. Timeout хука в settings — `3с`.

## Wiring (settings.json)

Регистрация — секция `hooks` в `~/.claude/settings.json`, которую пишет
`python3 hooks/install.py` (руками не править: установщик не трогает чужие хуки,
не дублирует при повторном запуске, снимает бэкап, умеет `--dry-run` и
`--uninstall`). Хуки лежат в `hooks/` репозитория и запускаются прямо оттуда:

| Событие | matcher | command | timeout (с) |
|---------|---------|---------|-------------|
| `Notification` | `""` | `node "<repo>/hooks/tg-notify.js"` | 10 |
| `PreToolUse` | `*` | `node "<repo>/hooks/tg-approve.js"` | 86700 |
| `PreToolUse` | `AskUserQuestion` | `node "<repo>/hooks/tg-ask-question.js"` | 86700 |
| `PreToolUse` | `ExitPlanMode` | `node "<repo>/hooks/tg-exit-plan.js"` | 86700 |
| `PreToolUse` | `""` | `bun "<repo>/channel-plugin/hooks/pre-tool-use.ts"` | 3 |
| `Stop` | `""` | `node "<repo>/hooks/tg-stop-mirror.js"` | 10 |

Замечания по wiring:
- **86700 с (24 ч + 5 мин) у трёх хуков одобрения — это требование, а не
  запас.** Плагин ждёт ответа в Telegram до 24 ч (`APPROVAL_TIMEOUT_MS`), хук —
  чуть дольше. Если таймаут Claude короче, он убивает хук, пока вопрос ещё висит
  в Telegram, и вызов инструмента идёт дальше обычным путём — в bypass-режиме это
  значит «выполнить». Раньше здесь стояло 660 с, и неотвеченный запрос через
  11 минут проходил сам — включая `gh pr merge` и `ansible-playbook`, которые
  `tg-approve.js` должен пропускать только по нажатию. Подтверждено владельцем
  на живой системе, исправлено 2026-09-24.
- `tg-bridge-locate.js` в settings **не регистрируется** — это `require`-helper,
  подключаемый из остальных `tg-*.js`.
- На событии `PreToolUse` висят два хука: `tg-approve.js` (matcher `*`,
  гейтит разрешения) и `pre-tool-use.ts` (matcher `""`, обновляет статус).
  Они независимы.
- В пути команд бэкслэши экранированы (`\\\\`) — это JSON-строки внутри
  Windows-путей.

## Requirements & gotchas

- **Node 22.5+.** `tg-bridge-locate.js` использует `node:sqlite` (`DatabaseSync`),
  добавленный в Node 22.5. На старом рантайме `require("node:sqlite")` бросает →
  `findOwnPlugin` возвращает `null` → хук тихо отключается (claude получает
  нативный flow). `pre-tool-use.ts` использует `bun:sqlite` (нужен Bun).
- **cmd-shim ppid.** Claude спавнит хуки через shell-shim, поэтому `process.ppid`
  — это PID шима, а не claude. Совпадение по `parent_pid` в одиночку **никогда не
  фаерится** для console-launched claude — реальный путь матчинга это cwd walk-up
  (см. [The gate](#the-gate-plugin-presence)). Из-за этого `findOwnPlugin(input.cwd)`
  всегда вызывается ПОСЛЕ парсинга stdin (нужен `input.cwd`).
- **Активация мгновенная.** Хуки заново исполняются на каждом событии (это
  отдельные процессы, а не загруженный в память код). Правка `tg-*.js` подхватится
  на следующем же событии — reload окна или рестарт claude НЕ нужны. (В отличие от
  channel plugin / extension, которые держат env и код в живом процессе.)
- **Хуки НЕ в репозитории.** Шесть `tg-*.js` (+ `tg-bridge-locate.js`) физически
  живут в `~/.claude/hooks/` и должны копироваться туда вручную — в репо их нет.
  Единственный репо-хук — `channel-plugin/hooks/pre-tool-use.ts`, на него
  `settings.json` ссылается абсолютным путём в дерево репо.
- **Чтение БД read-only.** Все хуки открывают `bot.db` в read-only, чтобы не
  создать файл, не взять write-lock и не блокировать тул-колл. Отсутствие таблицы
  → query кидает → `null` → no-op.
- **Liveness-порог 45с** (`HEARTBEAT_FRESH_SECONDS`) совпадает с
  `bridge/registry.py` бота: протухшая-но-не-реапнутая строка не должна увести
  прогресс/approval не в то окно (закрытый или переиспользованный порт).
