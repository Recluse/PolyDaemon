"""Bot-wide settings persisted outside config.yaml.

Currently holds just the global default-window override. Kept as a separate
module so future Settings menu entries (notification toggles, etc.) have a
natural home that doesn't pile up in permissions.py.
"""
from __future__ import annotations

import json
import logging

from bot.paths import DEFAULT_INSTANCE_PATH


logger = logging.getLogger(__name__)


def load_default_instance_override() -> str | None:
    """Return the persisted default-window key, or None if no override is set."""
    try:
        raw = json.loads(DEFAULT_INSTANCE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.exception("failed to read %s", DEFAULT_INSTANCE_PATH)
        return None
    if isinstance(raw, dict):
        key = raw.get("key")
        return str(key) if isinstance(key, str) and key else None
    return None


def save_default_instance_override(instance_key: str) -> None:
    from bot.common import atomic_write_text
    atomic_write_text(DEFAULT_INSTANCE_PATH, json.dumps({"key": instance_key}, indent=2))


def clear_default_instance_override() -> None:
    try:
        DEFAULT_INSTANCE_PATH.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        logger.exception("failed to clear %s", DEFAULT_INSTANCE_PATH)
