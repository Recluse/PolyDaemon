from __future__ import annotations

import json
import logging
from typing import Any

from telegram.ext import ContextTypes

from bot.common import atomic_write_text, refresh_instances
from bot.i18n import t
from bot.paths import PERMISSION_OVERRIDES_PATH


logger = logging.getLogger(__name__)


# Canonical mode identifiers — match Claude Code's `permissionMode` setting
# values so the channel plugin / future settings.local.json writers can use
# them verbatim.
MODE_DEFAULT = "default"
MODE_ACCEPT_EDITS = "acceptEdits"
MODE_PLAN = "plan"
MODE_AUTO = "auto"
MODE_BYPASS = "bypassPermissions"

MODES = [MODE_DEFAULT, MODE_ACCEPT_EDITS, MODE_PLAN, MODE_AUTO, MODE_BYPASS]

MODE_LABELS: dict[str, str] = {
    MODE_DEFAULT: "🤔 Ask before edits",
    MODE_ACCEPT_EDITS: "⚡ Edit automatically",
    MODE_PLAN: "📋 Plan mode",
    MODE_AUTO: "🪄 Auto mode",
    MODE_BYPASS: "🔓 Bypass permissions",
}

_MODE_HELP_KEYS: dict[str, str] = {
    MODE_DEFAULT: "perm.help_default",
    MODE_ACCEPT_EDITS: "perm.help_accept_edits",
    MODE_PLAN: "perm.help_plan",
    MODE_AUTO: "perm.help_auto",
    MODE_BYPASS: "perm.help_bypass",
}


# FUNCTION, not a dict of strings, for the same reason keyboards.py made its
# labels functions: a module-level t() runs at import, before i18n.configure()
# has read bot.locale, so the text would freeze at the default language.
def mode_help(mode: str) -> str:
    return t(_MODE_HELP_KEYS[mode])


# Live-enforced modes — others are stored as preference but require setting the
# corresponding Claude Code mode in the IDE UI to take effect.
LIVE_MODES = {MODE_BYPASS}


# Legacy ask/bypass → canonical mapping for the persisted override file.
_LEGACY_MIGRATION = {
    "ask": MODE_DEFAULT,
    "bypass": MODE_BYPASS,
}


def _normalize(raw: Any) -> dict[str, str]:
    """Coerce the on-disk shape to {workspace: canonical_mode}, dropping unknown values."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, str] = {}
    for ws, mode in raw.items():
        if not isinstance(ws, str) or not isinstance(mode, str):
            continue
        canonical = _LEGACY_MIGRATION.get(mode, mode)
        if canonical == MODE_DEFAULT:
            continue  # default state — don't store
        if canonical in MODES:
            result[ws] = canonical
    return result


# mtime-keyed memo. Avoids re-parsing the JSON on every keyboard rebuild /
# /permissions call / inline-callback. Stat is one syscall; an external edit
# (user hand-editing the file) bumps mtime → next call re-reads.
_cache: dict[str, str] | None = None
# Cache key is (mtime, size). mtime alone collides when two writes land in the
# same clock tick (coarse-resolution FS / rapid back-to-back saves) — adding the
# byte size catches the common case where the content length also changed.
_cache_key: tuple[float, int] = (-1.0, -1)


def _stat_key() -> tuple[float, int] | None:
    try:
        st = PERMISSION_OVERRIDES_PATH.stat()
    except OSError:
        return None
    return (st.st_mtime, st.st_size)


def load_permission_overrides() -> dict[str, str]:
    """Read overrides from disk. Auto-migrates legacy ask/bypass to canonical names.

    Cached by (mtime, size) — internal writes go through
    ``save_permission_overrides`` which keeps the cache in sync without re-stat'ing.
    """
    global _cache, _cache_key
    try:
        st = PERMISSION_OVERRIDES_PATH.stat()
    except FileNotFoundError:
        # File genuinely absent → no overrides (default for everyone). Don't
        # cache it — a fresh file might land before the next call.
        return {}
    except OSError:
        # Transient (lock / perms) — serve the last good cache rather than
        # spuriously dropping every workspace's mode.
        return _cache if _cache is not None else {}
    key = (st.st_mtime, st.st_size)

    if _cache is not None and key == _cache_key:
        return _cache

    try:
        raw = json.loads(PERMISSION_OVERRIDES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    migrated = _normalize(raw)
    if migrated != raw:
        try:
            save_permission_overrides(migrated)  # updates _cache via write-through
            logger.info("migrated permission-overrides.json to canonical mode names")
            return migrated
        except Exception:
            logger.exception("failed to persist migrated permission-overrides.json")

    _cache = migrated
    _cache_key = key
    return _cache


def save_permission_overrides(data: dict[str, str]) -> None:
    global _cache, _cache_key
    atomic_write_text(PERMISSION_OVERRIDES_PATH, json.dumps(data, indent=2))
    # Write-through: keep the in-memory copy + key in sync so the very next
    # load_permission_overrides() doesn't re-parse the file we just wrote.
    _cache = dict(data)
    _cache_key = _stat_key() or (-1.0, -1)


def get_mode_for_workspace(workspace: str) -> str:
    return load_permission_overrides().get(workspace, MODE_DEFAULT)


def set_mode_for_workspace(workspace: str, mode: str) -> None:
    if mode not in MODES:
        raise ValueError(f"Unknown permission mode: {mode!r}")
    overrides = load_permission_overrides()
    if mode == MODE_DEFAULT:
        overrides.pop(workspace, None)
    else:
        overrides[workspace] = mode
    save_permission_overrides(overrides)


def list_workspaces_with_modes(context: ContextTypes.DEFAULT_TYPE) -> list[tuple[str, str]]:
    """Currently-running workspaces with their current mode (canonical).

    Stale entries from `permission-overrides.json` are intentionally excluded —
    they still apply when the workspace boots back up, but we don't want them
    cluttering the menu after the session is closed.

    Keyed on ``inst.key`` (the DB ``workspace_name``) — was previously deriving
    via ``strip_port_suffix(display_name)``, which is two transformations away
    from the DB key and would silently drift the override-file schema the day
    display_name uniquification changes. The workspace_name is canonical.
    """
    instances = refresh_instances(context)
    overrides = load_permission_overrides()
    names = {inst.key for inst in instances}
    return sorted([(name, overrides.get(name, MODE_DEFAULT)) for name in names], key=lambda x: x[0].lower())


def perm_header() -> str:
    return t("perm.header")
