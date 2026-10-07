# VSCode Extension Design

## Purpose

Extension — это **launcher + локальный approval-UI endpoint**. Он не общается
ни с Telegram, ни с моделью напрямую. Его две задачи:

1. при открытии workspace автоматически поднять терминал с Claude Code CLI, чтобы
   к нему подключился channel-plugin (`server:tg-bridge`);
2. поднять localhost HTTP endpoint, который показывает нативный VS Code
   approval-диалог (Разрешить / Запретить) и которым пользуется хук
   `tg-approve.js`, гоняя его наперегонки с Telegram.

Весь inbound/outbound поток (Telegram ↔ Claude) идёт через channel-plugin (MCP)
и Python bot. Extension в этом потоке не участвует.

> **Изменения против старого дизайна.** Раньше extension сам обслуживал
> `vscode.lm` запросы, держал WebSocket server и регистрировал Copilot Chat
> participant `@tgbridge`. Ничего из этого больше нет: **нет websocket, нет
> `vscode.lm`, нет Copilot Chat participant, нет webview-зеркала, нет
> model-selection.** Источник истины — `vscode-extension/src/extension.ts`.

## Technology Stack

- Language: TypeScript (`tsc -p ./`, см. `package.json` → `compile`)
- Runtime: Node.js внутри VSCode extension host
- VSCode APIs: `window.createTerminal`, `window.showInformationMessage`,
  `extensions.getExtension`, `onDidChangeTerminalShellIntegration`
- Node stdlib: `http`, `fs`, `os`, `path`, `crypto`, `child_process`
- Внешних зависимостей нет (`dependencies: {}`)

## Structure

```text
vscode-extension/
├── package.json          # name: tg-copilot-bridge, version 0.0.2, publisher local
├── tsconfig.json
├── src/
│   └── extension.ts      # единственный модуль
└── out/
    ├── extension.js
    └── extension.js.map
```

- `activationEvents`: `onStartupFinished`
- `contributes`: пусто (нет команд, нет настроек, нет конфигурации в `settings.json`)

## Activation Flow

```text
activate()
 ├─ scheduleClaudeSpawn()      → поднимает терминал "Claude Code"
 └─ startApprovalEndpoint()    → поднимает HTTP endpoint на 127.0.0.1
```

Обе ветки запускаются параллельно (fire-and-forget) при `onStartupFinished`.

## 1. Auto-Spawn терминала Claude

`buildClaudeCommand()` собирает команду запуска:

```text
claude --dangerously-load-development-channels server:tg-bridge \
       --continue \
       --name <workspace-basename> \
       --permission-mode bypassPermissions
```

| Флаг | Зачем |
|------|-------|
| `--dangerously-load-development-channels server:tg-bridge` | подключить channel-plugin (research-preview Channels) |
| `--continue` | возобновить последнюю сессию в cwd workspace, чтобы reload окна не терял контекст. Намеренно **не** `--resume` — bare `--resume` открыл бы интерактивный picker и завесил unattended-запуск, столкнувшись с авто-Enter'ом баннера dev-channels |
| `--name <basename>` | имя инстанса = basename папки workspace, очищенный по `[^\w.\-]` → `_` |
| `--permission-mode bypassPermissions` | запуск без интерактивных approval-промптов |

Если workspace-папки нет, `--name` опускается.

`spawnClaudeTerminal()`:

- удаляет ранее восстановленный VS Code'ом терминал `"Claude Code"` (после
  reload оболочка восстанавливается, но процесс claude внутри уже мёртв — всегда
  пересоздаём, чтобы новая сессия подхватила актуальные флаги и MCP-конфиг);
- создаёт терминал с env `DISABLE_AUTOUPDATER=1`. Это пинит бинарь claude для
  VS Code-launched сессий: native-автоапдейтер переименовывал `claude.exe` →
  `claude.exe.old` посреди relaunch'а при reload окна, и терминал застревал на
  исчезнувшем пути. На ручных запусках апдейты по-прежнему работают;
- отправляет команду одним `sendText` по событию
  `onDidChangeTerminalShellIntegration` (через 1.5с после готовности
  shell-integration), с fallback-таймером 10с для оболочек, которые
  shell-integration не репортят. Ровно один `send` — ретраи дублировали бы
  команду claude.

## 2. Spawn timing — гонка с env-collection

`scheduleClaudeSpawn()` ждёт, пока расширения, мутирующие окружение оболочки
(прежде всего Python venv-activation), зарегистрируют свои
`EnvironmentVariableCollection`. Если поднять терминал раньше, а collection
прилетит после, VS Code авто-relaunch'ит терминал
(`terminal.integrated.environmentChangesRelaunch`, включён по умолчанию). На
холодных/тяжёлых workspace этот relaunch убивал claude посреди запуска и спамил
повторными venv+claude строками — окно так и не поднималось.

Решение детерминированное: дождаться активации Python-расширения
(`ms-python.python`) — к моменту резолва его `activate()` env-collection уже
зарегистрирована. Плюс пол и потолок по времени:

| Константа | Значение | Роль |
|-----------|----------|------|
| `MIN_WAIT` | 3000 ms | минимальный пол, чтобы и другие мутаторы (Copilot, …) успели |
| `MAX_WAIT` | 8000 ms | жёсткий потолок — зависшее/отсутствующее расширение не заблокирует запуск (`Promise.race`) |
| `SETTLE` | 500 ms | короткий settle, чтобы collection полностью применилась до старта shell |

(Раньше тут был фиксированный 4с-delay — догадка, которая проигрывала гонку на
тяжёлых workspace.)

## 3. Auto-confirm баннера dev-channels

`--dangerously-load-development-channels` выводит нативный TUI-баннер на **каждом**
запуске («WARNING: Loading development channels … > 1. I am using this for local
development … Enter to confirm»). Settings-ключа или env-переменной, чтобы его
подавить, нет — это намеренный research-preview friction.

`autoConfirmDevChannels()` шлёт пустой Enter несколько раз в stdin терминала
(`[2500, 4500, 7000, 10000]` ms), чтобы reload окна поднимался полностью
unattended. Опция 1 предвыбрана, так что bare Enter её подтверждает. Разброс по
времени покрывает разный cold-start (venv + node); пере-отправка безвредна
(слишком рано — keystroke буферизуется pty; слишком поздно — пустой Enter в REPL
это no-op).

## 4. Approval endpoint

`startApprovalEndpoint()` поднимает HTTP server на `127.0.0.1:0` (случайный
свободный порт). Маршрут — только `POST /approve`.

### Аутентификация (Bearer)

Endpoint **требует** `Authorization: Bearer <token>`:

- на старте окна генерируется 256-битный секрет (`crypto.randomBytes(32)` →
  hex);
- ожидаемое значение `Bearer <token>` сравнивается через
  `crypto.timingSafeEqual` (с предварительной проверкой длины);
- запрос без/с неверным заголовком → `401 unauthorized`.

Без токена любой локальный процесс (или вкладка браузера через DNS-rebinding на
127.0.0.1) мог бы заслать поддельное решение и выиграть approval-гонку в
`tg-approve.js`, авто-разрешив каждый tool. Токен пишется в endpoint-файл (та же
user-readable папка), откуда хук его и читает.

### Поведение

1. `POST /approve` с телом `{ tool_name, tool_input }`.
2. `summarizeForNotification()` строит краткое описание (для `Bash` — команда,
   для `WebFetch` — url, для `Edit`/`Write` — `file_path`, иначе имя tool'а;
   всё усечено до 120 символов).
3. Показывается немодальный `window.showInformationMessage("Claude wants to run:
   …")` с кнопками **Разрешить** / **Запретить**.
4. Ответ `200 application/json` с `{ decision, reason }`:

| Выбор пользователя | `decision` |
|--------------------|------------|
| Разрешить | `allow` |
| Запретить | `deny` |
| диалог закрыт / проигнорирован | `ignored` |

### Endpoint-дескриптор

При `listen` пишется файл
`~/.tg-copilot-bridge/extension-endpoints/<pid>.json`:

```json
{
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 49876,
  "workspace_path": "C:\\Work\\GITHUB\\tg-vscode-copilot",
  "workspace_name": "tg-vscode-copilot",
  "started_at": "<start-time-token>",
  "auth_token": "<256-bit hex>"
}
```

Хук `tg-approve.js` читает этот файл, аутентифицируется по `auth_token` и гоняет
endpoint наперегонки с Telegram-approval'ом. На `dispose` (закрытие окна) файл
удаляется и server закрывается.

## 5. Stale-endpoint sweep

Аварийно закрытое/крашнувшееся окно не выполняет dispose-handler — его
endpoint-файл остаётся висеть. Простой live-PID чек обманывается переиспользованием
PID (Windows агрессивно их реюзит), поэтому `cleanStaleEndpoints()` сравнивает
**start-time токен** процесса.

`procStartToken(pid)` — opaque токен времени старта процесса (PID-reuse-proof),
зеркалит хелперы channel-plugin и бота:

- Windows: `Get-CimInstance Win32_Process` → `CreationDate.ToFileTimeUtc()`;
- Linux: поле 22 из `/proc/<pid>/stat`;
- возврат: непустая строка → жив; `""` → процесса с этим PID нет; `null` →
  lookup не удался (консервативно — файл оставляем).

Логика реапа: если токен `""` → процесс мёртв, файл удаляем; если записанный
`started_at` не совпадает с текущим токеном → PID переиспользован, файл удаляем;
при `null` — не трогаем.

## Что extension НЕ делает (против старого дизайна)

| Старый дизайн | Сейчас |
|---------------|--------|
| WebSocket server (`ws`) для bot ↔ extension | нет — bot общается с channel-plugin'ом по HTTP |
| Обработка `vscode.lm` / `LanguageModelChatMessage` | нет — модель дёргает сам Claude Code |
| Copilot Chat participant `@tgbridge`, hybrid egress | нет |
| Webview-зеркало (`TG Workspace Chat`) | нет |
| Workspace tools (list/read/search/edit/rename) | нет — это инструменты самого Claude |
| Model selection / Quick Pick / dropdown | нет |
| Регистрация в `~/.tg-copilot-bridge/instances/` | нет — окно регистрирует channel-plugin в `bot.db`; extension пишет только endpoint-файл |
| Конфигурация `tgCopilotBridge.*` в `settings.json` | нет — `contributes` пуст |

Extension — это чистый launcher + локальный approval-UI endpoint.

## Deploy gotcha (критично)

VS Code запускает **установленную** копию расширения, а не репозиторную:

```text
~/.vscode/extensions/local.tg-copilot-bridge-0.0.2/out/extension.js   ← запускается ЭТО
vscode-extension/out/extension.js                                     ← НЕ это
```

После правки `extension.ts` нужно:

1. `npm run compile` в `vscode-extension/` (собирает `out/extension.js[.map]`);
2. скопировать `out/extension.js` **и** `out/extension.js.map` в установленную
   локацию `~/.vscode/extensions/local.tg-copilot-bridge-0.0.2/out/`;
3. **перезагрузить окно** (`Developer: Reload Window`).

Изменение расширения активируется только на reload окна. Забытый шаг копирования
= VS Code продолжает крутить старую установленную сборку, и правка «не работает»,
хотя репозиторий собран.

## Related Documents

- [channel-plugin.md](channel-plugin.md)
- [telegram-bot.md](telegram-bot.md)
- [http-mcp-protocol.md](http-mcp-protocol.md)
- [system-overview.md](system-overview.md)
- [../getting-started.md](../getting-started.md)
- [../runbooks/wmi-liveness-hang.md](../runbooks/wmi-liveness-hang.md)
