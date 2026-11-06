from __future__ import annotations

import ipaddress
import logging
import os
import time
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from bridge.client import InstanceConfig

# Prefix of the key the bot uses for a forum topic whose window is not running
# (bot.common.unavailable_target). No registered window may carry it.
UNAVAILABLE_PREFIX = "\u2298unavailable:"
# Same reservation for a target that names several live windows.
AMBIGUOUS_PREFIX = "\u2298ambiguous:"
_RESERVED_LEAD = "\u2298"

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
    # The registry row this instance came from (unique per plugin process), and
    # its parent pid / start token. Names repeat; these say WHICH process.
    row_id: str = ""
    parent_pid: int | None = None
    started_at: str = ""
    # Launcher-minted per-window id (TG_WINDOW_UID); "" for windows started
    # outside a launcher or by an older plugin.
    window_uid: str = ""
    # The agent the plugin reports; "" for older plugins (then derived from the
    # name suffix, see bot.topics.instance_agent).
    agent: str = ""
    # Set when this row cannot carry its window's identity: another live row
    # claims the same window_uid. Such rows are addressable only per row.
    uid_conflict: bool = False
    # The workspace (folder) name the plugin registered, unchanged by label
    # de-duplication: what a relaunch needs.
    workspace_name: str = ""


def row_agent(row: dict) -> str:
    """The agent of a registry row: the plugin's own report, else (older
    plugins) the instance-name suffix."""
    reported = str(row.get("agent") or "")
    if reported in ("claude", "codex", "opencode", "mimo"):
        return reported
    name = str(row.get("instance_name") or row.get("workspace_name") or "")
    for agent in ("codex", "opencode", "mimo"):
        if name.endswith(f"-{agent}"):
            return agent
    return "claude"


def route_identity(row: dict) -> dict:
    """What a message route must remember about the window that sent it, taken
    from the window's registry row (never from what a client claims)."""
    return {
        "row_id": str(row.get("id") or "") or None,
        "window_uid": str(row.get("window_uid") or "") or None,
        "scope_host": str(row.get("host") or "") or None,
        "scope_cwd": canonical_cwd(str(row.get("cwd") or "")) or None,
        "scope_agent": row_agent(row),
    }


def window_key(row_id: str, window_uid: str = "", scope: tuple[str, str, str] | None = None) -> str:
    """The bot's key for a window: ``w:<uid>@<scope hash>`` for a launcher-
    identified window, ``r:<row id>`` for one known only by its current
    incarnation. Never a name: names repeat across folders and hosts, and a key
    that is a name routes to whichever window holds it.

    The uid alone is not trusted (it is copied with an environment, and any
    enrolled peer can claim one): the key also covers host, folder and agent, so
    a stored key (active window, default window) can only ever resolve to a
    window in the same place, never to the same uid registered elsewhere."""
    if not window_uid:
        return f"r:{row_id}"
    import hashlib
    digest = hashlib.sha256("\x00".join((window_uid, *(scope or ("", "", "")))).encode()).hexdigest()[:12]
    return f"w:{window_uid}@{digest}"


def load_runtime_instances(
    config: dict[str, Any], storage: "Storage", *, keep_duplicates: bool = False,
) -> list[RuntimeInstance]:
    """Every live window, keyed by identity (see ``window_key``), not by name.

    Two windows that share a name, a folder, or a folder AND agent on one host
    are separate entries; choosing between them is the caller's job (and an
    ambiguous choice must be refused, not guessed). ``keep_duplicates`` is kept
    for callers that used to ask for every process; the result is the same."""
    rows: list[tuple[dict, RuntimeInstance]] = []
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
        row_id = str(row.get("id") or "")
        if not isinstance(port_value, int) or not row_id:
            continue

        name = str(row.get("workspace_name") or row.get("instance_name") or f"{host}:{port_value}")
        if name.startswith(_RESERVED_LEAD) or any(ord(ch) < 32 for ch in name):
            # The bot targets a topic whose window is down with a key carrying this
            # prefix; a registered window holding it would receive those messages.
            logger.warning("registry: dropping instance row with reserved or control characters in its name")
            continue
        uid = str(row.get("window_uid") or "")
        if uid and (len(uid) > 128 or any(ord(ch) < 33 for ch in uid)):
            uid = ""  # not an id we can key on; the row stays usable per incarnation

        rows.append((row, RuntimeInstance(
            key=window_key(row_id),
            display_name=name,
            instance_name=str(row.get("instance_name") or name),
            host=host,
            port=port_value,
            auth_token=str(row.get("auth_token") or ""),
            cwd=canonical_cwd(str(row.get("cwd") or "")),
            row_id=row_id,
            parent_pid=row.get("parent_pid") if isinstance(row.get("parent_pid"), int) else None,
            started_at=str(row.get("started_at") or ""),
            window_uid=uid,
            agent=str(row.get("agent") or ""),
            workspace_name=name,
        )))

    # A window id names ONE live incarnation. Two live rows with the same id
    # (a copied environment, a stale incarnation, a spoof) cannot both be that
    # window, and the newer is not necessarily the right one: none of them gets
    # the window key; each stays reachable per row and is flagged.
    by_uid: dict[str, list[RuntimeInstance]] = {}
    for _row, inst in rows:
        if inst.window_uid:
            by_uid.setdefault(inst.window_uid, []).append(inst)
    instances: list[RuntimeInstance] = []
    for _row, inst in rows:
        if inst.window_uid and len(by_uid[inst.window_uid]) == 1:
            agent = inst.agent if inst.agent in ("claude", "codex", "opencode", "mimo") else row_agent(_row)
            inst = replace(inst, key=window_key(inst.row_id, inst.window_uid, (inst.host, inst.cwd, agent)))
        elif inst.window_uid:
            inst = replace(inst, uid_conflict=True)
        instances.append(inst)
    for uid, group in by_uid.items():
        if len(group) > 1:
            logger.warning("registry: %d live windows claim the same window id (ports %s) — "
                           "each is addressable only by its own row", len(group),
                           ", ".join(str(i.port) for i in group))

    # Reap rows we judged dead so the table doesn't grow without bound. (A live PID
    # probe already ran for any row without a fresh heartbeat, so this is safe.)
    if stale_ids:
        storage.delete_instances(stale_ids)

    return _uniquify_display_names(sorted(instances, key=lambda i: (i.display_name.lower(), i.host, i.cwd, i.port)))


def instance_config(instance: RuntimeInstance) -> InstanceConfig:
    return InstanceConfig(name=instance.key, host=instance.host, port=instance.port, auth_token=instance.auth_token,
                          row_id=getattr(instance, "row_id", "") or "")


def build_instance_configs(instances: list[RuntimeInstance]) -> list[InstanceConfig]:
    return [instance_config(instance) for instance in instances]


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
    """Distinct labels for windows that share a name, so a person can pick the
    right one: the folder (and host) tells them apart, a short row id when even
    that repeats. Labels are for display only; nothing routes by them."""
    counts: dict[str, int] = {}
    for instance in instances:
        counts[instance.display_name] = counts.get(instance.display_name, 0) + 1

    def place(i: RuntimeInstance) -> str:
        tail = i.cwd.replace("\\", "/").rstrip("/").split("/")[-2:] if i.cwd else []
        return f"{i.host} {'/'.join(tail)}".strip()

    places: dict[tuple[str, str], int] = {}
    for instance in instances:
        k = (instance.display_name, place(instance))
        places[k] = places.get(k, 0) + 1

    result: list[RuntimeInstance] = []
    for instance in instances:
        if counts[instance.display_name] == 1 and not instance.uid_conflict:
            result.append(instance)
            continue
        label = f"{instance.display_name} [{place(instance)}"
        if places[(instance.display_name, place(instance))] > 1 or instance.uid_conflict:
            label += f" #{instance.row_id[-4:]}"
        label += "]" + (" ⚠️" if instance.uid_conflict else "")
        result.append(replace(instance, display_name=label))
    # Short row ids can still collide; then the full row id makes labels unique.
    seen: dict[str, int] = {}
    for instance in result:
        seen[instance.display_name] = seen.get(instance.display_name, 0) + 1
    return [replace(i, display_name=f"{i.display_name} #{i.row_id}") if seen[i.display_name] > 1 else i
            for i in result]
