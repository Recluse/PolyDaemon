from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from bridge.protocol import PingResult, WindowStatus


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class InstanceConfig:
    name: str
    host: str
    port: int
    auth_token: str


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
    ) -> None:
        self._instances: dict[str, InstanceConfig] = {}
        self._ping_timeout = ping_timeout
        self._post_timeout = post_timeout
        # Lazy: created on first use inside the event loop. Constructing
        # httpx.AsyncClient before run_polling() boots the loop occasionally
        # left the anyio backend in a state that hung the FIRST job (no logs,
        # silent stall on getUpdates). Lazy build sidesteps the issue while
        # still keeping one persistent client across the bot's lifetime.
        self._client: httpx.AsyncClient | None = None
        self.sync_instances(instances)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self._client

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

    async def post_message(self, instance_name: str, body: dict[str, Any]) -> None:
        """Fire-and-forget POST /message. Raises on auth failure or connection error."""
        instance = self._get_instance(instance_name)
        resp = await self._get_client().post(
            f"http://{instance.host}:{instance.port}/message",
            json=body,
            headers={"Authorization": f"Bearer {instance.auth_token}"},
            timeout=self._post_timeout,
        )
        if resp.status_code == 401:
            raise PermissionError(f"Auth failed for instance '{instance_name}' — check auth_token.")
        resp.raise_for_status()

    async def post_launch(self, agent_url: str, token: str, name: str, cwd: str = "", agent: str = "claude", new_session: bool = False) -> None:
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
        # Old launch agents silently ignore new fields and would start Claude.
        if agent != "claude" or new_session:
            health = await self._get_client().get(f"{agent_url.rstrip('/')}/health", timeout=self._post_timeout)
            health.raise_for_status()
            capabilities = health.json()
            if agent not in capabilities.get("agents", []) or (new_session and capabilities.get("new_session") is not True):
                raise RuntimeError("Update this machine's PolyDaemon launch-agent before selecting an agent or new session")
        resp = await self._get_client().post(
            f"{agent_url.rstrip('/')}/launch",
            json={"name": name, "cwd": cwd, "agent": agent, "new_session": new_session},
            headers={"Authorization": f"Bearer {token}"},
            timeout=self._post_timeout,
        )
        if resp.status_code == 401:
            raise PermissionError("launch-agent auth failed — check the shared token.")
        resp.raise_for_status()

    async def post_inject(self, instance_name: str, text: str) -> tuple[bool, str]:
        """POST /inject — type an in-session slash command (e.g. "/effort high")
        into the window's claude TUI.

        For REMOTE windows the bot can't AttachConsole (that's local-only), but the
        plugin is co-located with its claude process (its parent) and runs
        inject-keys.ps1 for us. Returns ``(ok, reason)``; ``reason`` carries the
        plugin's explanation on failure (e.g. an unsupported platform, or the script
        missing) so the caller can surface it. Never raises."""
        instance = self._instances.get(instance_name)
        if instance is None:
            return False, "instance not registered"
        try:
            resp = await self._get_client().post(
                f"http://{instance.host}:{instance.port}/inject",
                json={"text": text},
                headers={"Authorization": f"Bearer {instance.auth_token}"},
                timeout=self._post_timeout,
            )
            if resp.status_code == 200:
                return True, ""
            reason = ""
            try:
                reason = str((resp.json() or {}).get("reason") or "")
            except Exception:
                reason = ""
            return False, reason or f"HTTP {resp.status_code}"
        except Exception as exc:
            logger.debug("inject %s failed: %s", instance_name, exc)
            return False, str(exc)

    async def get_agent_version(self, agent_url: str, token: str) -> dict[str, Any] | None:
        """GET /version from a machine's launch-agent: its checkout's commit,
        branch, local edits and whether the hooks match it. None if unreachable
        or too old to have the endpoint."""
        try:
            resp = await self._get_client().get(
                f"{agent_url.rstrip('/')}/version",
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
            f"{agent_url.rstrip('/')}/update",
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
                f"http://{instance.host}:{instance.port}/context",
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

    async def post_approve_callback(self, instance_name: str, approval_id: str, action: str) -> bool:
        """POST /approve-callback. Returns True if the plugin accepted the resolution."""
        return await self._post_decision(instance_name, "/approve-callback", {"id": approval_id, "action": action})

    async def post_plan_callback(self, instance_name: str, plan_id: str, action: str) -> bool:
        """POST /plan-callback. ``action`` is ``"apply"`` or ``"decline"``."""
        return await self._post_decision(instance_name, "/plan-callback", {"id": plan_id, "action": action})

    async def post_ask_action(
        self,
        instance_name: str,
        ask_id: str,
        *,
        action: str | None = None,
        option_idx: int | None = None,
        text: str | None = None,
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
        return await self._post_decision(instance_name, "/ask-callback", body)

    async def _post_decision(self, instance_name: str, path: str, body: dict[str, object]) -> bool:
        async def send(instance: InstanceConfig) -> bool:
            try:
                resp = await self._get_client().post(
                    f"http://{instance.host}:{instance.port}{path}", json=body,
                    headers={"Authorization": f"Bearer {instance.auth_token}"},
                    timeout=self._post_timeout,
                )
                return resp.status_code == 200
            except Exception as exc:
                logger.debug("%s %s:%s failed: %s", path, instance.host, instance.port, exc)
                return False

        primary = self._instances.get(instance_name)
        if primary is None:
            return False
        if await send(primary):
            return True
        # Normal messages still go to the selected window. Only prompt-id-based
        # decisions probe its siblings; non-owners reject an unknown id with 404.
        siblings = {
            (i.host, i.port): i for i in self._decision_instances
            if i.name == instance_name and (i.host, i.port) != (primary.host, primary.port)
        }
        return any(await asyncio.gather(*(send(i) for i in siblings.values())))

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
                f"http://{instance.host}:{instance.port}/status",
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
                f"http://{instance.host}:{instance.port}/ping",
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
