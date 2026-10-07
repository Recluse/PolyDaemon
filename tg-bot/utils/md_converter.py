from __future__ import annotations

SPECIAL_CHARACTERS = "_[]()~`>#+-=|{}.!"


def escape_telegram_markdown(text: str) -> str:
    escaped = text
    for character in SPECIAL_CHARACTERS:
        escaped = escaped.replace(character, f"\\{character}")
    return escaped.replace("*", "\\*")


def to_telegram_markdown(markdown_text: str) -> str:
    """Return a conservative Telegram MarkdownV2-safe string for the MVP scaffold."""

    return escape_telegram_markdown(markdown_text)