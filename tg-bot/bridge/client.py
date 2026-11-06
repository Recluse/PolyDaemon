from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx

from bridge.protocol import PingResult, WindowStatus
from bridge.transport import DialMap


logger = logging.getLogger(__name__)
# Codex thread ids as the launchers accept them (they reach a shell command line).
_THREAD_ID = re.compile(r"[A-Za-z0-9_-]{1,160}")


@dataclass(slots=True)
class InstanceConfig:
    name: str
    host: str
    port: int
    auth_token: str
    # The registry row this endpoint was resolved from. A pinned request sends
    # it, and a plugin that is a different process (a new window on a reused
    # port) refuses. The bot scopes remote ids as "<ip>#<id>"; the plugin
    # knows only <id>.
    row_id: str = ""


def _row_header(instance: InstanceConfig | None) -> dict[str, str]:
    if instance is None or not instance.row_id:
        return {}
    return {"X-PolyDaemon-Row": instance.row_id.rsplit("#", 1)[-1]}


class ChannelPluginClient:
    """HTTP client for the tg-bridge channel plugin instances.

    Uses ONE shared `httpx.AsyncClient` across all calls — the previous
    per-call ``async with httpx.AsyncClient()`` pattern paid a full TCP +
    keep-alive handshake on every request. With N windows and an instance
    poll that fans out /status to all of them every few seconds, that was
    measurable latency. Keep-alive collapses repeat calls to the same plugin.
    """

    def __init__(
        self,
        instances: list[InstanceConfig],
        ping_timeout: float = 5.0,
        post_timeout: float = 10.0,
        transport_routes: dict[str, int] | None = None,
        transport_direct_hosts: list[str] | None = None,
    ) -> None:
        self._instances: dict[str, InstanceConfig] = {}
        self._ping_timeout = ping_timeout
        self._post_timeout = post_timeout
        self._dial = DialMap(transport_routes, transport_direct_hosts)
        # Lazy: created on first use inside the event loop. Constructing
        # httpx.AsyncClient before run_polling() boots the loop occasionally
        # left the anyio backend in a state that hung the FIRST job (no logs,
        # silent stall on getUpdates). Lazy build sidesteps the issue while
        # still keeping one persistent client across the bot's lifetime.
        self._client: httpx.AsyncClient | None = None
        self.sync_instances(instances)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(trust_env=False)
        return self._client

    def _instance_url(self, instance: InstanceConfig, path: str) -> str:
        return self._dial.url(f"http://{instance.host}:{instance.port}{path}")

    def sync_instances(
        self, instances: list[InstanceConfig], *,
        decision_instances: list[InstanceConfig] | None = None,
    ) -> None:
        self._instances = {i.name: i for i in instances}
        self._decision_instances = decision_instances if decision_instances is not None else instances

    async def aclose(self) -> None:
        """Close the shared client. Idempotent — safe to call repeatedly."""
        if self._client is None:
            return
        try:
            await self._client.aclose()
        except Exception:
            logger.debug("aclose failed", exc_info=True)
        self._client = None

    async def post_message(
        self, instance_name: str, body: dict[str, Any], *, pinned: InstanceConfig | None = None,
    ) -> None:
        """Fire-and-forget POST /message. Raises on auth failure or connection error.

        ``pinned`` sends to that exact process instead of whichever one holds the
        name when the request is built: names are workspace names, and between
        choosing a window and sending, a same-named window elsewhere can take it."""
        instance = pinned or self._get_instance(instance_name)
        resp = await self._get_client().post(
            self._instance_url(instance, "/message"),
            json=body,
            headers={"Authorization": f"Bearer {instance.auth_token}", **_row_header(pinned)},
            timeout=self._post_timeout,
        )
        if resp.status_code == 401:
            raise PermissionError(f"Auth failed for instance '{instance_name}' — check auth_token.")
        resp.raise_for_status()

    async def post_topic_activity(self, instance: InstanceConfig, body: dict[str, Any]) -> None:
        """Notify an exact live process, including siblings with their own pending prompts."""
        try:
            response = await self._get_client().post(
                self._instance_url(instance, "/topic-activity"), json=body,
                headers={"Authorization": f"Bearer {instance.auth_token}"}, timeout=self._ping_timeout,
            )
            if response.status_code != 404:  # older plugins simply lack this feature
                response.raise_for_status()
        except Exception:
            logger.debug("topic activity delivery failed; registry and decisions unchanged")

    async def launch_supports_thread(self, agent_url: str) -> bool:
        """Whether this machine's launch-agent can resume an exact Codex thread
        (`thread_resume` in /health). An older agent would ignore `thread_id` and
        fall back to the folder lookup, so /restart asks before closing anything."""
        agent_url = self._dial.url(agent_url)
        try:
            health = await self._get_client().get(f"{agent_url.rstrip('/')}/health", timeout=self._post_timeout)
            health.raise_for_status()
            return health.json().get("thread_resume") is True
        except Exception as exc:
            logger.debug("launch-agent health %s failed: %s", agent_url, exc)
            return False

    async def get_codex_thread(self, instance_name: str) -> tuple[str | None, str]:
        """GET /codex-thread — the Codex thread bound to that window (agentd's
        window binding, see agent/codex-bindings.ts). Returns (thread_id, '') or
        (None, reason). Never a "newest thread in the folder" guess."""
        instance = self._instances.get(instance_name)
        if instance is None:
            return None, "window not found"
        try:
            resp = await self._get_client().get(
                self._instance_url(instance, "/codex-thread"),
                headers={"Authorization": f"Bearer {instance.auth_token}"},
                timeout=25.0,
            )
            if resp.status_code == 404:
                return None, "window plugin too old to report its Codex thread"
            data = resp.json()
        except Exception as exc:
            return None, f"window unreachable: {exc}"
        thread = data.get("thread_id") if isinstance(data, dict) else None
        if not isinstance(data, dict) or data.get("ok") is not True:
            return None, str((data or {}).get("reason") or f"HTTP {resp.status_code}")[:300]
        if not isinstance(thread, str) or not _THREAD_ID.fullmatch(thread):
            return None, "window has no Codex thread yet"
        return thread, ""

    async def post_launch(self, agent_url: str, token: str, name: str, cwd: str = "", agent: str = "claude", new_session: bool = False,
                          thread_id: str = "") -> None:
        """POST /launch to a machine's launch-agent (clients/launch-agent.ts).

        Used when the bot runs apart from the workspaces (e.g. on the bot host while
        the windows are on the Windows PC): the agent spawns launch-ws.ps1 there.
        Reuses the shared httpx pool + Bearer auth — the same mesh transport the
        bot uses to reach plugins, no SSH. Raises on failure so the caller can
        surface it to the user. `cwd`, when known, lets the agent open that exact
        folder instead of searching its workspace root for `name`; an older agent
        ignores the extra field and searches as before."""
        if agent not in ("claude", "codex", "opencode", "mimo") or not isinstance(new_session, bool):
            raise ValueError("invalid launch agent or session mode")
        if thread_id and (agent != "codex" or new_session or not _THREAD_ID.fullmatch(thread_id)):
            raise ValueError("invalid thread selection")
        agent_url = self._dial.url(agent_url)
        # Old launch agents silently ignore new fields and would start Claude.
        if agent != "claude" or new_session:
            health = await self._get_client().get(f"{agent_url.rstrip('/')}/health", timeout=self._post_timeout)
            health.raise_for_status()
            capabilities = health.json()
            if agent not in capabilities.get("agents", []) or (new_session and capabilities.get("new_session") is not True):
                raise RuntimeError("Update this machine's PolyDaemon launch-agent before selecting an agent or new session")
            if thread_id and capabilities.get("thread_resume") is not True:
                raise RuntimeError("This machine's launch-agent cannot resume an exact Codex thread")
        body = {"name": name, "cwd": cwd, "agent": agent, "new_session": new_session}
        if thread_id:
            body["thread_id"] = thread_id
        resp = await self._get_client().post(
            f"{agent_url.rstrip('/')}/launch",
            json=body,
            headers={"Authorization": f"Bearer {token}"},
            timeout=100.0,  # the launcher may handle startup prompts for up to 90s
        )
        if resp.status_code == 401:
            raise PermissionError("launch-agent auth failed — check the shared token.")
        if not resp.is_success:
            try:
                reason = resp.json().get("reason")
            except (ValueError, AttributeError):
                reason = None
            if reason:
                raise RuntimeError(str(reason))
        resp.raise_for_status()
        if resp.json().get("ok") is not True:
            raise RuntimeError("launch-agent did not confirm launcher completion")

    async def post_inject(
        self, instance_name: str, text: str, *, pinned: InstanceConfig | None = None,
    ) -> tuple[bool, str]:
        """POST /inject — type an in-session slash command (e.g. "/effort high")
        into the window's claude TUI.

        For REMOTE windows the bot can't AttachConsole (that's local-only), but the
        plugin is co-located with its claude process (its parent) and types it for
        us. Returns ``(ok, reason)``; ``ok`` means the keys were typed, not that the
        command ran (see ``post_inject_outcome``). ``reason`` carries the plugin's
        explanation on failure so the caller can surface it. Never raises."""
        outcome, reason = await self.post_inject_outcome(instance_name, text, pinned=pinned)
        return outcome in ("confirmed", "unconfirmed"), reason

    async def post_inject_outcome(
        self, instance_name: str, text: str, *, pinned: InstanceConfig | None = None,
        require_empty_prompt: bool = False,
    ) -> tuple[str, str]:
        """Like ``post_inject``, with what came of it: ``confirmed`` (the window's
        transcript shows the command running), ``unconfirmed`` (typed, outcome
        unknown — also every plugin too old to tell), ``as_text`` (it reached the
        model as a prompt), ``refused`` (nothing typed: the prompt held input),
        ``unsupported`` (``require_empty_prompt`` and the terminal cannot show the
        input) or ``failed``. Never raises."""
        instance = pinned or self._instances.get(instance_name)
        if instance is None:
            return "failed", "instance not registered"
        body: dict[str, Any] = {"text": text}
        if require_empty_prompt:
            body["require_empty_prompt"] = True
        try:
            resp = await self._get_client().post(
                self._instance_url(instance, "/inject"),
                json=body,
                headers={"Authorization": f"Bearer {instance.auth_token}", **_row_header(pinned)},
                timeout=self._post_timeout,
            )
            data: dict[str, Any] = {}
            try:
                data = resp.json() or {}
            except Exception:
                data = {}
            reason = str(data.get("reason") or "")
            outcome = str(data.get("outcome") or "")
            if resp.status_code == 200:
                return (outcome if outcome in ("confirmed", "unconfirmed") else "unconfirmed"), reason
            if outcome in ("as_text", "refused", "unsupported"):
                return outcome, reason
            # A plugin too old to know require_empty_prompt typed nothing only if it
            # failed; it never reports refusals, so anything else is a failure.
            return "failed", reason or f"HTTP {resp.status_code}"
        except Exception as exc:
            logger.debug("inject %s failed: %s", instance_name, exc)
            return "failed", str(exc)

    async def get_agent_version(self, agent_url: str, token: str) -> dict[str, Any] | None:
        """GET /version from a machine's launch-agent: its checkout's commit,
        branch, local edits and whether the hooks match it. None if unreachable
        or too old to have the endpoint."""
        try:
            resp = await self._get_client().get(
                self._dial.url(f"{agent_url.rstrip('/')}/version"),
                headers={"Authorization": f"Bearer {token}"},
                timeout=20.0,   # it runs git and install.py --check
            )
            return resp.json() if resp.is_success else None
        except Exception as exc:
            logger.debug("agent version %s failed: %s", agent_url, exc)
            return None

    async def post_update(self, agent_url: str, token: str, sha: str) -> dict[str, Any]:
        """POST /update to a launch-agent: fast-forward its checkout to `sha` (which
        must already be in its upstream) and re-register the hooks. Returns the
        agent's step-by-step answer; raises when the agent cannot be reached."""
        resp = await self._get_client().post(
            self._dial.url(f"{agent_url.rstrip('/')}/update"),
            json={"sha": sha},
            headers={"Authorization": f"Bearer {token}"},
            timeout=240.0,   # a git fetch over a slow link, then install.py
        )
        if resp.status_code == 404:
            return {"ok": False, "reason": "agent too old for /update — update it by hand once"}
        return resp.json()

    async def get_context(self, instance_name: str) -> dict[str, Any] | None:
        """GET /context — the window's context-window occupancy, computed by the
        plugin from its own claude transcript (the bot can't read it cross-host).
        Returns {"used", "model", "idle_s", "uptime_s"} or None. ``idle_s`` is
        seconds since that window's newest transcript record and ``uptime_s`` is
        how long the window itself has been up; both are None on a plugin too old
        to report them (the caller must treat unknown values as "do not act")."""
        instance = self._instances.get(instance_name)
        if instance is None:
            return None
        try:
            resp = await self._get_client().get(
                self._instance_url(instance, "/context"),
                headers={"Authorization": f"Bearer {instance.auth_token}"},
                timeout=self._ping_timeout,
            )
            if not resp.is_success:
                return None
            data = resp.json()
            if not data.get("ok"):
                return None
            raw_idle = data.get("idle_s")
            raw_up = data.get("uptime_s")
            return {
                "used": int(data.get("used") or 0),
                "model": str(data.get("model") or ""),
                "idle_s": None if raw_idle is None else int(raw_idle),
                "uptime_s": None if raw_up is None else int(raw_up),
                # None, not False, from a plugin too old to report it: /restart all
                # tells "idle" from "does not say" (bot/exit_window.py
                # classify_for_restart), and False here made every old window idle.
                "busy": data["busy"] if isinstance(data.get("busy"), bool) else None,
                # The commit the window started with; '' from a plugin too old to say.
                "code_sha": str(data.get("code_sha") or ""),
            }
        except Exception as exc:
            logger.debug("context %s failed: %s", instance_name, exc)
            return None

    async def post_approve_callback(self, instance_name: str, approval_id: str, action: str,
                                    *, pinned: InstanceConfig | None = None) -> bool:
        """POST /approve-callback. Returns True if the plugin accepted the resolution."""
        return await self._post_decision(instance_name, "/approve-callback", {"id": approval_id, "action": action},
                                         pinned=pinned)

    async def post_plan_callback(self, instance_name: str, plan_id: str, action: str,
                                 *, pinned: InstanceConfig | None = None) -> bool:
        """POST /plan-callback. ``action`` is ``"apply"`` or ``"decline"``."""
        return await self._post_decision(instance_name, "/plan-callback", {"id": plan_id, "action": action},
                                         pinned=pinned)

    async def post_ask_action(
        self,
        instance_name: str,
        ask_id: str,
        *,
        action: str | None = None,
        option_idx: int | None = None,
        text: str | None = None,
        pinned: InstanceConfig | None = None,
    ) -> bool:
        """POST /ask-callback for an AskUserQuestion event.

        Action wire-formats (mirror channel-plugin/server.ts):
          - single-select pick:   action=None, option_idx=<int>
          - multiSelect toggle:   action='toggle', option_idx=<int>
          - multiSelect commit:   action='done'
          - custom-text request:  action='custom'
          - custom-text answer:   action=None, text=<str>
        """
        body: dict[str, object] = {"id": ask_id}
        if action is not None:
            body["action"] = action
        if option_idx is not None:
            body["idx"] = option_idx
        if text is not None:
            body["text"] = text
        return await self._post_decision(instance_name, "/ask-callback", body, pinned=pinned)

    async def _post_decision(self, instance_name: str, path: str, body: dict[str, object],
                             pinned: InstanceConfig | None = None) -> bool:
        async def send(instance: InstanceConfig) -> bool:
            try:
                resp = await self._get_client().post(
                    self._instance_url(instance, path), json=body,
                    headers={"Authorization": f"Bearer {instance.auth_token}", **_row_header(instance)},
                    timeout=self._post_timeout,
                )
                return resp.status_code == 200
            except Exception as exc:
                logger.debug("%s %s:%s failed: %s", path, instance.host, instance.port, exc)
                return False

        # Only the process that issued the prompt id may act on it: send to that
        # exact row (pinned by X-PolyDaemon-Row), never to other processes that
        # happen to share the key.
        primary = pinned or self._instances.get(instance_name)
        if primary is None:
            return False
        return await send(primary)

    async def get_status(
        self,
        instance_name: str,
        *,
        timeout: float | None = None,
    ) -> WindowStatus | None:
        """GET /status. Snapshot of the plugin's current turn progress."""
        instance = self._instances.get(instance_name)
        if instance is None:
            return None
        try:
            resp = await self._get_client().get(
                self._instance_url(instance, "/status"),
                headers={"Authorization": f"Bearer {instance.auth_token}"},
                timeout=timeout if timeout is not None else self._ping_timeout,
            )
            if not resp.is_success:
                return None
            data = resp.json()
            lines = data.get("progress_lines") or []
            recent = data.get("recent_events") or []
            last_edit = data.get("last_edit_ts")
            return WindowStatus(
                instance_name=str(data.get("instance_name", instance_name)),
                workspace=str(data.get("workspace", "")),
                is_working=bool(data.get("is_working", False)),
                progress_lines=[str(s) for s in lines],
                last_edit_ts=float(last_edit) if last_edit is not None else None,
                pending_approve=bool(data.get("pending_approve", False)),
                pending_ask=bool(data.get("pending_ask", False)),
                pending_plan=bool(data.get("pending_plan", False)),
                recent_events=[str(s) for s in recent],
            )
        except Exception as exc:
            logger.debug("status %s failed: %s", instance_name, exc)
            return None

    async def ping(
        self,
        instance_name: str,
        *,
        timeout: float | None = None,
    ) -> PingResult | None:
        """GET /ping. Returns None if the instance is unreachable."""
        instance = self._instances.get(instance_name)
        if instance is None:
            return None
        try:
            resp = await self._get_client().get(
                self._instance_url(instance, "/ping"),
                headers={"Authorization": f"Bearer {instance.auth_token}"},
                timeout=timeout if timeout is not None else self._ping_timeout,
            )
            if not resp.is_success:
                return None
            data = resp.json()
            return PingResult(
                instance_name=str(data.get("instance_name", instance_name)),
                workspace=str(data.get("workspace", "")),
            )
        except Exception as exc:
            logger.debug("ping %s failed: %s", instance_name, exc)
            return None

    async def ping_many(
        self,
        instance_names: list[str],
        *,
        timeout: float | None = None,
    ) -> list[PingResult | None]:
        return list(await asyncio.gather(*(self.ping(n, timeout=timeout) for n in instance_names)))

    def _get_instance(self, instance_name: str) -> InstanceConfig:
        instance = self._instances.get(instance_name)
        if instance is None:
            raise KeyError(f"Unknown instance: '{instance_name}'. Check ~/.tg-copilot-bridge/instances/.")
        return instance
