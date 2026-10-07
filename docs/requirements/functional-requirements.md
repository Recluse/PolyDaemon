# Functional Requirements

## Goal

Система должна дать пользователю возможность обращаться к Claude Code прямо из Telegram и направлять запрос в конкретное окно VSCode.

## Core Requirements

### FR-001 Telegram to Claude Code chat

- Пользователь должен иметь возможность отправить текстовое сообщение в Telegram bot.
- Bot должен переслать запрос в активный Channel Plugin через HTTP POST.
- Channel Plugin доставляет сообщение в Claude Code через MCP `notifications/claude/channel`.
- Ответ Claude приходит обратно в Telegram через `reply` tool call плагина.

### FR-002 Processing indicator

- Bot должен отправлять `typing` action в Telegram при получении сообщения.
- Пользователь получает один финальный ответ (не streaming); индикатор показывает, что запрос обрабатывается.

### FR-003 Multi-window targeting

- Система должна поддерживать несколько окон VSCode одновременно.
- Каждое окно регистрирует свой Channel Plugin в `~/.tg-copilot-bridge/instances/`.
- Пользователь должен иметь возможность выбрать активное окно командой `/window`.
- Bot должен хранить выбранное окно в пользовательской сессии.

### FR-004 Context reset

- Команда `/clear` должна отправить в Claude Code специальную инструкцию начать диалог заново.
- История диалога хранится в Claude Code, не в боте; `/clear` влияет на сессию Claude Code.

### FR-005 Image input

- Пользователь должен иметь возможность отправить изображение вместе с caption или без него.
- Bot должен передавать изображение (base64) и сопутствующий текст в channel plugin как единый запрос.
- Channel Plugin включает изображение в MCP channel notification.

### FR-006 Operational commands

- `/start` должен показывать приветствие и базовую справку.
- `/help` должен показывать доступные команды.
- `/status` должен показывать список доступных окон с их статусом (online / offline).
- `/window` должен показывать reply keyboard для выбора активного окна.

### FR-007 Markdown adaptation

- Ответы Claude в Markdown должны преобразовываться в Telegram MarkdownV2.
- Преобразование выполняется в Channel Plugin перед отправкой через `reply` tool.
- Длинные ответы (> 4096 символов) разбиваются на несколько сообщений без повреждения форматирования.

### FR-008 Error handling

- При недоступности выбранного окна bot должен уведомить пользователя и предложить выбрать другой instance.
- При HTTP 401 от plugin — уведомить об ошибке конфигурации.
- Ошибка не должна разрушать пользовательскую сессию.

## User Scenarios

### Scenario A: Basic request

1. Пользователь вызывает `/start`.
2. Отправляет текстовый вопрос.
3. Видит `typing` индикатор.
4. Получает ответ Claude в активном окне VSCode.

### Scenario B: Window switching

1. Пользователь вызывает `/window`.
2. Видит reply keyboard со списком доступных окон (только online).
3. Нажимает нужное окно — выбор сохраняется в сессии.
4. Следующие сообщения идут в выбранное окно.

### Scenario C: Vision request

1. Пользователь отправляет скриншот с подписью.
2. Bot передаёт изображение и caption в channel plugin.
3. Claude получает изображение в контексте и отвечает по содержимому.
