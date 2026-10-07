from __future__ import annotations

import ipaddress
import logging
import os
import time
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from bridge.client import InstanceConfig

if TYPE_CHECKING:
    from bot.storage import Storage


logger = logging.getLogger(__name__)

# A window's row counts as live without a PID probe while its heartbeat is this
# fresh. The plugin heartbeats every 15s (channel-plugin/server.ts). Every window
# reaches the bot over the WG mesh (home ↔ colo), and heartbeatRemote is a single
# 4s POST with no retry — so a short burst of WG jitter/loss drops a few beats in
# a row. At 45s (3 beats) that reaped LIVE remote windows every few minutes → the
# topic flickered 🔴 and the plugin re-registered (live case 2026-09-01, worse on
# the flakier-path box). 120s tolerates ~7 missed beats, absorbing the jitter; a
# genuinely dead REMOTE window still shows 🔴 within ~2 min (local rows fall back
# to the PID probe immediately, so their detection is unaffected).
HEARTBEAT_FRESH_SECONDS = 120.0

# Loopback hosts = same-machine plugins (PID-probable). Anything else must fall
# inside the configured mesh subnet to be accepted — a row whose host is neither
# is dropped so a planted entry can't redirect the per-instance auth token to an
# off-mesh address. The mesh subnet comes from config (bot.mesh_subnet).
#
# The default below is an RFC 5737 DOCUMENTATION range, deliberately: it matches
# nobody's real network, so a deploy that forgets bot.mesh_subnet rejects every
# remote plugin instead of silently trusting whatever subnet this constant used to
# name. Loopback plugins are unaffected, so a single-machine setup still works out
# of the box; cross-machine requires saying which subnet is yours.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
DEFAULT_MESH_SUBNET = "198.51.100.0/24"  # RFC 5737 TEST-NET-2 — configure bot.mesh_subnet


def _host_allowed(host: str, mesh_nets) -> tuple[bool, bool]:
    """Return (allowed, is_local). is_local ⇒ same-machine ⇒ PID-probable.

    ``mesh_nets`` is a list of allowed subnets — a host is accepted if it falls
    inside ANY of them, so several mesh LANs (e.g. colo 198.51.100.0/24 and home
    192.0.2.0/24) are equal first-class peers.
    """
    if host in _LOOPBACK_HOSTS:
        return True, True
    if mesh_nets:
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return False, False
        for net in mesh_nets:
            if ip in net:
                return True, False
    return False, False


def is_local_host(host: str) -> bool:
    """Is this row's plugin on the SAME machine as the bot?

    Two callers, one question, and both of them get it wrong in the same
    direction if they guess: a remote row treated as local gets its (remote) pid
    probed against the local process table, where an unrelated process can match
    and revive a window that is dead.
    """
    if host in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def canonical_cwd(cwd: str) -> str:
    """Canonical workspace key — MUST match the plugin's ``canonicalCwd()``
    (channel-plugin/src/config.ts). Windows reports the cwd drive letter in mixed
    case (``C:\\…`` vs ``c:\\…``); keyed raw, one folder becomes two windows →
    duplicate forum topics and reloads that don't resume. Uppercasing the drive
    letter collapses them. No-op on POSIX paths. Applied once, where cwd enters
    the bot (``load_runtime_instances``), so every downstream comparison
    (``resolve_workspace_id``, inbound topic→window routing) is already canonical.
    """
    if len(cwd) >= 2 and cwd[1] == ":" and cwd[0].islower():
        return cwd[0].upper() + cwd[1:]
    return cwd


@dataclass(slots=True)
class RuntimeInstance:
    key: str
    display_name: str
    instance_name: str
    host: str
    port: int
    auth_token: str
    # Absolute working directory the plugin reported (process.cwd()). Stable
    # across restarts on the same host, so it's the binding key for forum topics
    # (see bot/topics.py). Empty for older plugins that didn't write `cwd`.
    cwd: str = ""


def load_runtime_instances(
    config: dict[str, Any], storage: "Storage", *, keep_duplicates: bool = False,
) -> list[RuntimeInstance]:
    # Identity is the workspace NAME, not host:port. Ports rotate freely across
    # restarts, and two windows must never collide on identity just because one
    # reused (or held a stale registration on) the other's port — that silently
    # mis-routed a topic to the wrong window before. Names are curated unique per
    # host; the duplicate-name path below is only a misconfiguration safety net.
    instances_by_key: dict[str, RuntimeInstance] = {}
    # Stable tiebreak token of the current winner per key: (started_at, -port).
    # started_at is an opaque per-OS process-creation token (digits) — fixed for a
    # process's whole lifetime — so a winner chosen by it does NOT change between
    # refreshes. This is what stops two concurrently-live windows on the same
    # folder from ping-ponging the routing (see the same-cwd branch below).
    chosen_by_key: dict[str, tuple[int, int]] = {}
    processes: list[RuntimeInstance] = []
    stale_ids: list[str] = []
    now = time.time()

    # Mesh subnet (roaming plugins register their mesh IP); loopback is always
    # allowed. Parsed once per refresh.
    mesh_nets = []
    raw_subnet = config.get("bot", {}).get("mesh_subnet", DEFAULT_MESH_SUBNET)
    # Accept a single subnet (str) or a list of subnets — multiple mesh LANs
    # (e.g. colo + home) are equal peers. Parsed once per refresh.
    subnet_list = raw_subnet if isinstance(raw_subnet, (list, tuple)) else [raw_subnet]
    for entry in subnet_list:
        entry = str(entry).strip()
        if not entry:
            continue
        try:
            mesh_nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            logger.warning("registry: invalid bot.mesh_subnet entry %r — skipped", entry)

    for row in storage.get_instances():
        host = str(row.get("host") or "127.0.0.1")
        # Loopback = same-machine (PID-probable); mesh IP = roaming plugin
        # (heartbeat-only liveness). Anything else is misconfigured or a planted
        # row trying to exfiltrate the per-instance auth_token (the bot would POST
        # chat text + `Authorization: Bearer <token>` to that host) — drop it.
        allowed, is_local = _host_allowed(host, mesh_nets)
        if not allowed:
            logger.warning("registry: dropping instance row with off-mesh host %r", host)
            continue

        if _row_is_stale(row, now, is_local):
            stale_ids.append(str(row.get("id")))
            continue

        port_value = row.get("port")
        if not isinstance(port_value, int):
            continue

        # Fallback chain keeps older plugins (no workspace_name) working.
        key = str(row.get("workspace_name") or row.get("instance_name") or f"{host}:{port_value}")

        instance = RuntimeInstance(
            key=key,
            display_name=str(row.get("workspace_name") or row.get("instance_name") or key),
            instance_name=str(row.get("instance_name") or key),
            host=host,
            port=port_value,
            auth_token=str(row.get("auth_token") or ""),
            cwd=canonical_cwd(str(row.get("cwd") or "")),
        )

        # Decisions carry a random prompt id owned by ONE process. Keep every
        # validated endpoint for those, including subagents sharing a workspace.
        if keep_duplicates:
            processes.append(instance)
            continue

        # Later-started wins; lower port breaks ties. Both are stable, unlike the
        # old "freshest heartbeat wins" — which flip-flopped every ~15s between two
        # live windows and silently split a topic's inbound across them. '' / non
        # numeric started_at → 0 so a tokenless row never shadows one that has it.
        raw_token = str(row.get("started_at") or "")
        token = int(raw_token) if raw_token.isdigit() else 0
        cand = (token, -port_value)

        prior = instances_by_key.get(key)
        if prior is None:
            instances_by_key[key] = instance
            chosen_by_key[key] = cand
            continue

        if prior.cwd and instance.cwd and prior.cwd != instance.cwd:
            # Two *different* workspaces share a name — the user is meant to keep
            # these unique. Keep the winner and warn so it's diagnosable instead
            # of silently shadowing one window.
            logger.warning(
                "registry: workspace name %r used by two cwds (%s vs %s) — keep one; rename the other",
                key, prior.cwd, instance.cwd,
            )
        else:
            # Same folder open in two live windows — routing can target only one.
            # This is the "messages only sometimes arrive" cause: warn loudly and
            # keep a STABLE winner so inbound stops ping-ponging between windows.
            logger.warning(
                "registry: workspace %r (%s) has two live windows (ports %s, %s) — "
                "routing to the later-started one; close the extra window",
                key, instance.cwd or prior.cwd, prior.port, instance.port,
            )

        if cand > chosen_by_key[key]:
            instances_by_key[key] = instance
            chosen_by_key[key] = cand

    # Reap rows we judged dead so the table doesn't grow without bound. (A live PID
    # probe already ran for any row without a fresh heartbeat, so this is safe.)
    if stale_ids:
        storage.delete_instances(stale_ids)

    return _uniquify_display_names(
        sorted(processes if keep_duplicates else instances_by_key.values(),
               key=lambda i: (i.display_name.lower(), i.port))
    )


def build_instance_configs(instances: list[RuntimeInstance]) -> list[InstanceConfig]:
    return [
        InstanceConfig(
            name=instance.key,
            host=instance.host,
            port=instance.port,
            auth_token=instance.auth_token,
        )
        for instance in instances
    ]


def _pid_exists(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        exit_code = ctypes.c_ulong()
        alive = bool(ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)))
        ctypes.windll.kernel32.CloseHandle(handle)
        return alive and exit_code.value == 259  # 259 = STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _proc_start_token(pid: int) -> str | None:
    """Opaque process start-time token, matching the plugin's ``_procStartTime``.

    Returns the same per-OS token the plugin writes into ``started_at`` (Windows:
    whole seconds of CreationDate since 1601 UTC; Linux: ``starttime`` from
    /proc/<pid>/stat). Used to detect PID reuse: a live PID alone doesn't prove
    it's the same process that registered, because Windows recycles PIDs.

      - non-empty str → alive; the string identifies which process
      - ""            → no process at this PID (exited)
      - None          → lookup failed; caller falls back to plain liveness
    """
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        # use_last_error + explicit signatures: HANDLE is 64-bit on Win64 and the
        # default restype (c_int) would truncate it, corrupting the handle.
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.GetProcessTimes.restype = wintypes.BOOL
        k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k32.CloseHandle.argtypes = [wintypes.HANDLE]

        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            # ERROR_INVALID_PARAMETER (87) means no such PID; anything else
            # (e.g. access denied) is "unknown" so we don't reap a live window.
            return "" if ctypes.get_last_error() == 87 else None
        try:
            creation = wintypes.FILETIME()
            exit_t = wintypes.FILETIME()
            kernel_t = wintypes.FILETIME()
            user_t = wintypes.FILETIME()
            ok = k32.GetProcessTimes(
                handle,
                ctypes.byref(creation), ctypes.byref(exit_t),
                ctypes.byref(kernel_t), ctypes.byref(user_t),
            )
            if not ok:
                return None
            filetime = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
            return str(filetime // 10_000_000)  # whole seconds since 1601 UTC
        finally:
            k32.CloseHandle(handle)
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            stat = fh.read()
    except FileNotFoundError:
        return ""
    except OSError:
        return None
    # comm (field 2) may contain spaces/parens — parse after the last ')'.
    # Remaining tokens start at field 3 (state); starttime (field 22) is index 19.
    rest = stat[stat.rfind(")") + 1:].split()
    return rest[19] if len(rest) > 19 else None


def _row_is_stale(row: dict[str, Any], now: float, is_local: bool = True) -> bool:
    """True if an `instances` row no longer represents a live window.

    Fast path: a fresh heartbeat means live without touching the PID (avoids a
    per-row process probe on every refresh). For LOCAL rows, when the heartbeat
    lapses we fall back to the same PID/start-time logic the file registry used
    — a live PID alone isn't proof the window is up, because Windows recycles
    PIDs (we've seen one reused by OpenConsole.exe), so compare the start-time
    token the plugin recorded. For REMOTE rows the PID belongs to another host
    (probing the local PID table would give a false match), so heartbeat
    freshness is the ONLY liveness signal — a lapsed remote heartbeat = stale.
    """
    heartbeat = row.get("heartbeat_at")
    if isinstance(heartbeat, (int, float)) and (now - heartbeat) <= HEARTBEAT_FRESH_SECONDS:
        return False

    if not is_local:
        return True  # remote + heartbeat lapsed → dead (no cross-host PID probe)

    pid = row.get("pid")
    if isinstance(pid, int) and pid > 1:
        live = _proc_start_token(pid)
        if live == "":
            return True  # PID gone → window exited
        if live is None:
            # Token lookup failed — fall back to plain liveness.
            return not _pid_exists(pid)
        recorded = row.get("started_at")
        if isinstance(recorded, str) and recorded and recorded != live:
            return True  # PID reused by another process → original is dead

    return False


def _uniquify_display_names(instances: list[RuntimeInstance]) -> list[RuntimeInstance]:
    counts: dict[str, int] = {}
    for instance in instances:
        counts[instance.display_name] = counts.get(instance.display_name, 0) + 1

    result: list[RuntimeInstance] = []
    for instance in instances:
        if counts[instance.display_name] == 1:
            result.append(instance)
        else:
            result.append(replace(instance, display_name=f"{instance.display_name} [{instance.port}]"))
    return result
