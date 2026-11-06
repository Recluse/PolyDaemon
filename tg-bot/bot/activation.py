"""Local single-process guard and an explicit manual activation permit.

The permit is NOT a distributed lease. Operators must fence the previous host
before granting the next host a permit; network failure never grants one.

Standalone installations set none of POLYDAEMON_NODE_ID,
POLYDAEMON_ACTIVATION_FILE and POLYDAEMON_NODE_ROLE and keep the old startup
contract. Setting any of them declares a primary/reserve deployment, and then
a missing or mismatched permit refuses polling. A deployment that is meant to
be HA but sets none of the three cannot be told apart from standalone here.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

HA_ROLES = ("primary", "reserve")
# How often a running HA router re-reads its permit. A demote that writes the
# deny value then stops polling even if the controller's stop command failed.
PERMIT_RECHECK_S = 15.0


def permit_declared(node: str | None, permit: str | None, role: str | None) -> bool:
    # A variable that is SET but empty (a failed substitution in a compose
    # file) still declares an HA deployment; only all three unset is standalone.
    return not (node is None and permit is None and role is None)


def permit_watch(node: str | None, permit: str | None, role: str | None):
    """PTB job callback: stop polling as soon as the permit no longer grants this node."""
    async def _job(context) -> None:
        try:
            check_permit(node, permit, role)
        except RuntimeError as exc:
            logger.error("activation permit withdrawn (%s); stopping polling", exc)
            context.application.stop_running()
    return _job


def check_permit(node: str | None, permit: str | None, role: str | None = None) -> None:
    if node is None and permit is None and role is None:
        return  # Standalone installations retain the existing startup contract.
    if role is not None and role not in HA_ROLES:
        raise RuntimeError("POLYDAEMON_NODE_ROLE must be primary or reserve")
    if not node or not permit or not Path(permit).is_absolute():
        raise RuntimeError("Activation requires a node ID and an absolute permit path")
    try:
        granted = Path(permit).read_text(encoding="utf-8").strip()
    except (OSError, ValueError) as exc:  # ValueError covers UnicodeDecodeError: deny
        raise RuntimeError("Activation permit unavailable; polling forbidden") from exc
    if granted != node:
        raise RuntimeError("Standby node: activation permit does not match; polling forbidden")


@contextmanager
def router_guard(directory: Path, node: str | None, permit: str | None,
                 role: str | None = None):
    check_permit(node, permit, role)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "router.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if lock.seek(0, 2) == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_permit(node, permit, role)
        yield
