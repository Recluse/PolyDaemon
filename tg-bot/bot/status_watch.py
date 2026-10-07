from __future__ import annotations

import logging

import httpx
from telegram.ext import ContextTypes

from bot.i18n import t
from bot.registry_watch import infra_warn_chat_id


logger = logging.getLogger(__name__)

# Independent provider-outage watch.
#
# Why it lives in the BOT and not in a window's plugin: when the model API is
# down, the windows are exactly what goes quiet — a turn dies mid-flight and the
# session can sit wedged on retries. On 2026-09-03 the owner poked a window six
# times during a 529 burst and got nothing back, because the thing that should
# have reported the outage was the thing the outage had killed. The bot runs on
# bot-host, independent of every window and plugin, so it survives that.
#
# Both providers publish Statuspage, which exposes a stable `status.indicator`
# (none|minor|major|critical) — no scraping, no API key, no credentials.
#
# Honest limitation: a status page LAGS. That same 529 burst may never have been
# posted there at all. So this catches declared incidents, while the plugin-side
# api-error surfacing catches real-time errors but only while a window lives.
# The two are complementary; neither replaces the other.
PROVIDERS: dict[str, tuple[str, str]] = {
    "Claude": ("https://status.claude.com/api/v2/status.json", "https://status.claude.com"),
    "OpenAI": ("https://status.openai.com/api/v2/status.json", "https://status.openai.com"),
}

_OK = "none"
_EMOJI = {"minor": "⚠️", "major": "🔴", "critical": "🚨"}
_TIMEOUT = 10.0


def transition_message(name: str, page: str, prev: str | None, ind: str, desc: str) -> str | None:
    """The message a state change warrants, or None to stay quiet.

    `prev is None` is the first observation after a (re)start. We stay silent if
    all is well, but DO speak up if we wake into an ongoing incident — otherwise a
    bot restart mid-outage would swallow the one notice that matters. The bot
    redeploys often, so a healthy baseline must never announce itself.
    """
    if not ind:
        return None
    if prev == ind:
        return None
    if prev is None:
        if ind == _OK:
            return None
        return t("status.incident_ongoing", emoji=_EMOJI.get(ind, "⚠️"), name=name,
                 desc=desc, indicator=ind, page=page)
    if ind == _OK:
        return t("status.recovered", name=name, page=page)
    return t("status.incident", emoji=_EMOJI.get(ind, "⚠️"), name=name,
             desc=desc, indicator=ind, page=page)


async def status_watch_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    application = context.application
    config = application.bot_data.get("config", {})
    if not config.get("bot", {}).get("status_watch_enabled", True):
        return

    state: dict[str, str] = application.bot_data.setdefault("provider_status", {})
    chat_id = infra_warn_chat_id(application)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for name, (url, page) in PROVIDERS.items():
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                status = (resp.json() or {}).get("status") or {}
                ind = str(status.get("indicator") or "").strip().lower()
                desc = str(status.get("description") or "").strip()
            except Exception as exc:
                # A failed probe is NOT an outage signal — the status page itself
                # can be unreachable (our egress, their CDN). Recording a problem
                # would cry wolf; recording OK would fake a recovery. So leave the
                # last known state untouched and try again next tick.
                logger.debug("status_watch: %s probe failed: %s", name, exc)
                continue

            prev = state.get(name)
            msg = transition_message(name, page, prev, ind, desc)
            if ind:
                state[name] = ind
            if prev is None and ind:
                # One breadcrumb per start. Without it "the watch is alive and all
                # is well" and "the watch is silently dead" look IDENTICAL in the
                # log — both are silence. That ambiguity is this design's one real
                # weakness, so leave a mark when the baseline is first established.
                logger.info("status_watch: baseline %s=%s (%s)", name, ind, desc)
            if msg is None:
                continue
            logger.info("status_watch: %s %s -> %s", name, state.get(name), ind)
            if chat_id is None:
                continue
            try:
                await application.bot.send_message(chat_id, msg, parse_mode="HTML")
            except Exception:
                logger.exception("status_watch: failed to deliver %s notice", name)
