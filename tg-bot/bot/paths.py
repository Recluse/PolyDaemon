"""Filesystem paths the bot shares with the channel plugin.

`active-instances.json` is still written here for the plugin's "Reply here"
button logic — the plugin reads it synchronously and we don't want to migrate
that contract now. Routes and sessions live in SQLite (bot.db).
"""
from __future__ import annotations

from pathlib import Path


BRIDGE_DIR = Path.home() / ".tg-copilot-bridge"

# Plugin reads this to decide whether the user's active window is *this* plugin
# (drives the "Ответить здесь" button on cross-window replies).
ACTIVE_INSTANCES_PATH = BRIDGE_DIR / "active-instances.json"

# Hook reads this to skip Telegram/VSCode approval for selected workspaces.
PERMISSION_OVERRIDES_PATH = BRIDGE_DIR / "permission-overrides.json"

# Shared SQLite DB (sessions + message_routes). Written by both bot and plugin
# under WAL so concurrent reads/writes don't lock each other out.
DB_PATH = BRIDGE_DIR / "bot.db"

# Global default-window override set via the «🪟 Дефолтное окно» entry in
# Settings. When present, takes priority over `config.yaml: bot.default_instance`.
DEFAULT_INSTANCE_PATH = BRIDGE_DIR / "default-instance.json"

# Bot-written projection of window_topics for the channel plugin to read when
# mirroring outbound messages into per-window forum topics (Slice 2). Keyed by
# the same workspace_id the plugin can compute from its own process.cwd().
TOPIC_BINDINGS_PATH = BRIDGE_DIR / "topic-bindings.json"
