from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import yaml
from telegram import Update
from telegram.error import NetworkError
from telegram.ext import Application

from bot.commands import register_bot_commands
from bot.error import error_handler
from bot.handlers import register_handlers
from bot.paths import DB_PATH
from bot import i18n, topics
from bot.status_watch import status_watch_job
from bot.compact_watch import compact_watch_job
from bot.registry_watch import (
    DEFAULT_POLL_INTERVAL,
    broadcast_changes_job,
    cleanup_routes_job,
    disk_watch_job,
)
from bot.session import SessionStore
from bot.storage import Storage
from bridge.client import ChannelPluginClient
from bridge.registry import build_instance_configs, load_runtime_instances


LOGGER_NAME = "tg-router-bot"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)-18s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
# Silence per-request long-poll chatter — httpx logs every getUpdates round-trip,
# httpcore traces the underlying connection, and telegram.ext.Updater echoes both.
for noisy in ("httpx", "httpcore", "telegram.ext.Updater", "apscheduler"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


class CompactNetworkErrors(logging.Filter):
    """Collapse transient Bot-API connectivity failures to one line per window.

    The local Bot API sits behind an ssh tunnel (:8081 → bot-host) that drops
    from time to time. While it's down, EVERY getUpdates poll and every job
    that touches the Bot API raises ``NetworkError``, and each landing in the
    log carried a ~30-line PTB request-stack traceback — megabytes of noise
    for one routine event. PTB's polling loop retries forever
    (``network_retry_loop(max_retries=-1)``), so these are not actionable:
    the bot reconnects by itself the moment the tunnel returns.

    Installed on the root HANDLER (not a logger), so it sees records from
    every logger — PTB's updater, our error_handler, job wrappers. Any record
    whose exc_info is a NetworkError (incl. TimedOut subclass; RetryAfter is
    NOT a NetworkError and keeps its full trace):
      - is rewritten to a single WARNING line (no traceback), and
      - repeats within WINDOW_SECONDS are dropped, counted, and reported in
        the next line that passes ("+N suppressed").
    """

    WINDOW_SECONDS = 30.0

    def __init__(self) -> None:
        super().__init__()
        self._last_pass = 0.0
        self._suppressed = 0

    def filter(self, record: logging.LogRecord) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        if not isinstance(exc, NetworkError):
            return True
        now = time.monotonic()
        if now - self._last_pass < self.WINDOW_SECONDS:
            self._suppressed += 1
            return False
        suppressed, self._suppressed = self._suppressed, 0
        self._last_pass = now
        origin = record.getMessage()
        extra = f" (+{suppressed} suppressed in last {int(self.WINDOW_SECONDS)}s)" if suppressed else ""
        record.msg = (
            f"network error: {exc.__class__.__name__}: {exc} — Bot API unreachable, "
            f"retrying [{origin}]{extra}"
        )
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.levelno = logging.WARNING
        record.levelname = "WARNING"
        return True


for _handler in logging.getLogger().handlers:
    _handler.addFilter(CompactNetworkErrors())

logger = logging.getLogger(LOGGER_NAME)


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def build_bridge_client(config: dict[str, Any], storage: Storage) -> ChannelPluginClient:
    bot_config = config.get("bot", {})
    instances = build_instance_configs(load_runtime_instances(config, storage))
    return ChannelPluginClient(
        instances,
        ping_timeout=float(bot_config.get("ping_timeout", 5.0)),
        post_timeout=float(bot_config.get("post_timeout", 10.0)),
    )


def build_application(config: dict[str, Any]) -> Application:
    telegram_config = config["telegram"]
    token = telegram_config["bot_token"]

    # Fail closed on an empty allowlist, and fail LOUDLY rather than by going
    # quiet. This bot types into live Claude Code sessions on the operator's own
    # machines, in bypassPermissions — an open door here is arbitrary code
    # execution for whoever finds the bot, so "empty means everyone" was the
    # wrong default to ship. Refusing at startup (rather than accepting nobody)
    # is the difference between a message that names the fix and a bot that
    # answers nothing for reasons no log explains. Same fail-closed stance the
    # registry already takes on a weak enroll token.
    if not (telegram_config.get("allowed_users") or []):
        raise SystemExit(
            "config telegram.allowed_users is empty — refusing to start.\n"
            "This bot injects into live coding sessions, so it must know whose "
            "messages to accept.\n"
            "Add your numeric Telegram user id:\n"
            "  telegram:\n"
            "    allowed_users:\n"
            "      - 123456789\n"
            "Run /chatid in a chat with the bot to see your id."
        )
    bot_config = config.get("bot", {})
    poll_interval = float(bot_config.get("instance_poll_interval", DEFAULT_POLL_INTERVAL))

    # Local Bot API server lifts the 20MB-download / 50MB-upload caps to ~1990MB.
    # In local mode getFile returns a server-local path; PTB reads it directly
    # (local_mode=True) instead of fetching over HTTP.
    use_local = bool(telegram_config.get("use_local_bot_api", False))
    api_base = str(telegram_config.get("api_base_url", "https://api.telegram.org")).strip().rstrip("/")

    storage = Storage(DB_PATH)
    sessions = SessionStore(storage, default_instance=str(bot_config.get("default_instance", "")))
    bridge_client = build_bridge_client(config, storage)

    # Optional inbound registration server for ROAMING plugins on other machines
    # (see bot/http_registry.py). Off unless bot.registry_bind_host is set, so the
    # current single-machine deploy is unaffected. Bind to the MESH iface only.
    registry_host = str(bot_config.get("registry_bind_host", "")).strip()
    registry_port = int(bot_config.get("registry_port", 8090))
    registry_token = str(bot_config.get("registry_enroll_token", "")).strip()
    # Default ON (direct mesh). Set false when the registry is behind NAT (Docker
    # published port / router that rewrites source), where the seen source IP won't
    # match the plugin's advertised mesh IP. See bot/http_registry.py.
    registry_verify_source_ip = bool(bot_config.get("registry_verify_source_ip", True))
    registry_server = None  # set in _post_init, closed in _post_shutdown

    async def _post_init(app: Application) -> None:
        await register_bot_commands(app)

        nonlocal registry_server
        if registry_host:
            import asyncio

            from bot.http_registry import start_registry_server
            from bridge.registry import is_local_host
            from bot.interwindow import InterWindowRouter
            # Fail closed: a mesh-exposed registry with a weak/absent enroll token
            # is an open door (anyone who can reach the port can register a window
            # and capture its chat + auth). Refuse to start with a clear log line
            # rather than letting make_registry_server raise into the generic except.
            if not is_local_host(registry_host) and len(registry_token) < 32:
                logger.error(
                    "registry NOT started: registry_bind_host=%s is non-loopback but "
                    "registry_enroll_token is missing/short (need >= 32 bytes). "
                    "Set a strong bot.registry_enroll_token in config.yaml.",
                    registry_host,
                )
            else:
                try:
                    # Window-to-window messaging runs on THIS event loop; the sync
                    # registry thread bridges to it via run_coroutine_threadsafe.
                    router = InterWindowRouter(app, bridge_client, storage, config)
                    registry_server = start_registry_server(
                        storage, registry_host, registry_port, registry_token,
                        verify_source_ip=registry_verify_source_ip,
                        router=router, loop=asyncio.get_running_loop(),
                    )
                except Exception:
                    logger.exception("failed to start registry HTTP server on %s:%s", registry_host, registry_port)

        # JobQueue: poll the bot.db `instances` table for newly registered /
        # departed windows (the registry is no longer file-watched), plus hourly
        # cleanup of stale message routes.
        if poll_interval > 0:
            app.job_queue.run_repeating(
                broadcast_changes_job,
                interval=poll_interval,
                first=0.5,
                name="instance-refresh",
            )
        app.job_queue.run_repeating(
            cleanup_routes_job,
            interval=3600.0,   # hourly
            first=60.0,
            name="route-cleanup",
        )
        # Warn before the bot's state filesystem fills; agent disks are remote.
        app.job_queue.run_repeating(
            disk_watch_job,
            interval=600.0,   # every 10 min
            first=20.0,
            name="disk-watch",
        )
        # Independent provider-outage watch. Deliberately here and not in a
        # window's plugin: when the model API dies, the windows are what go
        # silent, so the reporter must not be one of them.
        app.job_queue.run_repeating(
            status_watch_job,
            interval=float(config.get("bot", {}).get("status_poll_interval", 120.0)),
            first=15.0,
            name="status-watch",
        )
        # Idle compaction: compact a window that has been silent for hours and
        # is carrying a big context. Claude's own auto-compact stays off (it
        # fired at load time on a full resume); this trigger cannot, because
        # loading is not idleness. See bot/compact_watch.py.
        app.job_queue.run_repeating(
            compact_watch_job,
            interval=float(config.get("bot", {}).get("compact_poll_interval", 300.0)),
            first=120.0,
            name="compact-watch",
        )

    async def _post_shutdown(app: Application) -> None:
        if registry_server is not None:
            try:
                registry_server.shutdown()
            except Exception:
                logger.exception("registry server shutdown failed")
        try:
            await bridge_client.aclose()
        except Exception:
            logger.exception("bridge_client aclose failed")
        try:
            storage.close()
        except Exception:
            logger.exception("storage close failed")

    builder = Application.builder().token(token)
    if use_local:
        builder = (
            builder
            .base_url(f"{api_base}/bot")
            .base_file_url(f"{api_base}/file/bot")
            .local_mode(True)
        )
        logger.info("Using local Bot API server at %s (local_mode=True)", api_base)
    application = (
        builder
        .post_init(_post_init)
        .post_shutdown(_post_shutdown)
        .build()
    )

    # UI language first: everything that renders text must resolve it AFTER this,
    # which is why reply-keyboard labels are functions rather than constants.
    i18n.configure(config)
    # Cosmetic topic settings (icon keywords, status markers) live in config so
    # the shipped defaults stay generic — see bot/topics.py::configure.
    topics.configure(config)

    register_handlers(application, config, sessions, bridge_client, storage)
    # Inbound media handling forks on this: cloud mode base64-inlines images;
    # local mode hands every attachment (images included) to Claude as a
    # file_id, because the bytes live on the server's volume, not the host.
    application.bot_data["use_local"] = use_local
    application.add_error_handler(error_handler)
    return application


def main() -> None:
    config_path = Path(__file__).with_name("config.yaml")
    config = load_config(config_path)
    application = build_application(config)
    logger.info("Starting Telegram bot polling.")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
