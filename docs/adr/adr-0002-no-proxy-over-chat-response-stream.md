# ADR-0002: Безопасное оборачивание `vscode.ChatResponseStream`

## Status
Accepted — 2026-05-04

## Context
Мост `tg-copilot-bridge` перехватывает вызовы методов `ChatResponseStream`
(в первую очередь `markdown`) для трансляции ответов Copilot Chat в
Telegram. Первоначальная реализация в `vscode-extension/src/officialChatBridge.ts`
использовала `Proxy` с ловушкой `get`, подменявшей `markdown` на
функцию-обёртку.

В рантайме это приводит к ошибке:

```
TypeError: 'get' on proxy: property 'markdown' is a read-only and
non-configurable data property on the proxy target but the proxy did
not return its actual value (expected 'markdown(l){...}' but got
'(value) => { const text = typeof value === "string" ? value : value.value; ... }')
```

Причина — внутренние методы `ChatResponseStream` в современных сборках
VS Code объявлены через `Object.defineProperty` с
`writable: false, configurable: false`. По спецификации ECMA-262
(Proxy invariants) ловушка `get` для таких свойств обязана вернуть
ровно то же значение, что лежит на target. Любая подмена нарушает
инвариант и приводит к `TypeError`.

## Decision
Стандартный способ оборачивания — **делегирующая обёртка**: обычный
объект, в котором собраны все методы исходного стрима (own + цепочка
прототипов), забинженные на оригинальный `stream`. После сборки
методы, которые требуется перехватить (например, `markdown`),
переопределяются явно. `Proxy` над `ChatResponseStream` не используется.

Если в будущем потребуется динамическая диспетчеризация и `Proxy`
неизбежен, ловушка `get` обязана проверять дескриптор свойства и для
non-configurable / non-writable свойств возвращать
`Reflect.get(target, prop, receiver)` без подмены.

## Consequences
- Плюс: устойчивость к изменениям внутренней реализации VS Code API
  (private classes, frozen prototypes).
- Плюс: явный читаемый контракт обёртки, легко расширяется новыми
  перехватами.
- Минус: при появлении методов через `Symbol`-ключи их придётся
  пробрасывать вручную. На текущем `ChatResponseStream` это не
  актуально.

## Alternatives Considered
- **Proxy без проверки дескрипторов.** Текущая регрессия — нарушает
  Proxy invariants на non-configurable методах. Отклонено.
- **Proxy с `Reflect.get` для non-configurable свойств.** Работает,
  но скрывает намерение и хрупок: достаточно одного нового
  non-configurable метода с конфликтующим override, чтобы получить
  регрессию. Допустимо только как утилита, когда явная обёртка
  невозможна.
- **Monkey-patch `stream.markdown = ...`.** Невозможен — свойство
  non-writable.
- **Наследование от класса стрима.** Класс не экспортируется в
  публичном API VS Code.
