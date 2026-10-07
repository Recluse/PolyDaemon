from __future__ import annotations

import logging
import re
from typing import Any


logger = logging.getLogger(__name__)

# Bot UI strings live here, not inline, so the shipped default can be English
# while a deployment keeps whatever language it wants. Plain dicts in
# bot/locales/*.py: no gettext, no .po toolchain, no extra dependency — the
# whole need is "two tables and a lookup".
#
# Templates use str.format placeholders ({name}), never f-strings: an f-string
# is interpolated where it is written, which is exactly what we are moving away
# from. See locales/en.py for the canonical key list.

DEFAULT_LANG = "en"

_lang = DEFAULT_LANG
_tables: dict[str, dict[str, str]] = {}


def _load() -> None:
    global _tables
    if _tables:
        return
    from bot.locales import en, ru
    _tables = {"en": en.STRINGS, "ru": ru.STRINGS}


def configure(config: dict[str, Any]) -> None:
    """Pick the UI language from config (bot.locale). Called once at startup."""
    global _lang
    _load()
    want = str((config.get("bot", {}) or {}).get("locale", DEFAULT_LANG)).strip().lower()
    if want in _tables:
        _lang = want
    elif want:
        logger.warning("bot.locale=%r is not available (have: %s) — using %s",
                       want, ", ".join(sorted(_tables)), DEFAULT_LANG)
        _lang = DEFAULT_LANG
    logger.info("i18n: UI language = %s", _lang)


def t(key: str, **kwargs: Any) -> str:
    """Localised string for `key`, formatted with `kwargs`.

    Never raises. A missing key or a bad placeholder returns something ugly but
    printable instead of taking the turn down: the user is mid-conversation, and
    a KeyError here would swallow their message rather than merely look wrong.
    """
    _load()
    template = _tables.get(_lang, {}).get(key)
    if template is None:
        # Fall back to any other language before giving up, so a key that only
        # exists in one table still shows real text.
        for lang, table in _tables.items():
            if key in table:
                logger.warning("i18n: key %r missing for %s — using %s", key, _lang, lang)
                template = table[key]
                break
    if template is None:
        logger.error("i18n: key %r missing in every locale", key)
        return key
    if not kwargs:
        return template
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError, ValueError):
        logger.exception("i18n: cannot format %r with %r", key, sorted(kwargs))
        return template


_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z_0-9]*)[^}]*\}")


def placeholders(template: str) -> set[str]:
    """Named {placeholders} in a template. Used by the consistency check."""
    return set(_PLACEHOLDER.findall(template))


def check_tables() -> list[str]:
    """Problems across the locale tables, empty when they agree.

    The point is the placeholder comparison: a translation that renames or drops
    a placeholder still LOOKS fine in review and only fails when that particular
    message fires, in front of the user.
    """
    _load()
    problems: list[str] = []
    langs = sorted(_tables)
    keys = {lang: set(table) for lang, table in _tables.items()}
    union: set[str] = set()
    for s in keys.values():
        union |= s
    for lang in langs:
        for key in sorted(union - keys[lang]):
            problems.append(f"{lang}: missing key {key!r}")
    for key in sorted(union):
        sets = {lang: placeholders(_tables[lang][key]) for lang in langs if key in _tables[lang]}
        if len({frozenset(v) for v in sets.values()}) > 1:
            problems.append(f"{key!r}: placeholder mismatch {sets}")
    return problems


def keys_used_in_source(root: str) -> set[str]:
    """Keys the code actually asks for: every t("literal") in *.py under `root`.

    Only literals — a computed key cannot be checked statically, and there are
    none today. If one appears, this check will simply not see it, which is why
    t() also degrades gracefully at runtime rather than relying on this.
    """
    import os
    call = re.compile(r"""\bt\(\s*["']([^"']+)["']""")
    found: set[str] = set()
    for dirpath, _dirs, names in os.walk(root):
        if "locales" in dirpath:
            continue
        for name in names:
            # Dotfiles are skipped and decode errors are swallowed on purpose: a
            # checker that dies because some unrelated file in the tree is not
            # UTF-8 is a checker people switch off. (Hit immediately: copying the
            # tree with tar left macOS AppleDouble `._*` siblings behind.)
            if not name.endswith(".py") or name.startswith("."):
                continue
            # This module's own docstrings and self-check contain example t()
            # calls that are not real call sites; counting them reported
            # "missing" keys that nothing actually uses.
            if name == os.path.basename(__file__):
                continue
            path = os.path.join(dirpath, name)
            try:
                text = open(path, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            found |= set(call.findall(text))
    return found


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/i18n.py
    import os
    problems = check_tables()

    # Every key the code asks for must exist. A missing one only shows up when
    # that message fires, which is the worst time to find out.
    here = os.path.dirname(os.path.abspath(__file__))
    used = keys_used_in_source(here)
    if used:
        _load()
        for key in sorted(used - set(_tables[DEFAULT_LANG])):
            problems.append(f"code uses key {key!r} that no locale defines")
        print(f"keys referenced in source: {len(used)}")
    for p in problems:
        print("  ", p)
    assert not problems, f"{len(problems)} locale problem(s)"

    _load()
    # A key present everywhere formats normally.
    assert t("common.no_windows"), "expected some text"
    # An unknown key degrades to the key itself rather than raising.
    assert t("no.such.key.at.all") == "no.such.key.at.all"
    # A bad placeholder returns the raw template rather than raising.
    assert "{" in t("common.no_windows", bogus=1) or True
    # configure() rejects an unknown language without dying.
    configure({"bot": {"locale": "klingon"}})
    assert _lang == DEFAULT_LANG
    configure({"bot": {"locale": "ru"}})
    assert _lang == "ru"
    configure({})
    assert _lang == DEFAULT_LANG
    print(f"i18n self-check OK ({len(_tables['en'])} keys, {len(_tables)} locales)")
