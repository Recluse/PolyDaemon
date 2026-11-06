#!/usr/bin/env python3
"""Replicate router state to the standby host and restore it on promotion.

push:    capture a verified per-file snapshot of the live state directory and
         copy it to the standby over ssh, retaining the last N copies there.
restore: adopt the newest verified snapshot into a state directory before the
         router starts on a promoted node.

Restore is deliberately explicit (run by an operator as a runbook step, never
from the failover controller, which rejects it in pre_start_cmd), never
triggered by the backup capture itself: an online capture is per-file, not an
atomic checkpoint, and adopting it is a failover decision rather than a
routine side effect. Overwriting a populated state directory (--force) also
requires fresh fencing evidence (--fencing-evidence or POLYD_FENCING_EVIDENCE): rolling live state back to an older
snapshot while the old node may still accept writes loses those writes and
turns their completed Telegram updates back into replayable `pending` rows.
Only router_online_backup captures are accepted; a router_state.py quiesced
snapshot has a different manifest and is restored per the cutover runbook.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from router_online_backup import capture, verify  # noqa: E402
from polyd_failover import EVIDENCE_ENV, load_fencing_evidence, router_up  # noqa: E402

logger = logging.getLogger("polyd-state-sync")

KEEP_DEFAULT = 5


def ssh(host: str, args: list[str], timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, *args],
                          capture_output=True, text=True, timeout=timeout)


def push(source: Path, host: str, remote_root: str, keep: int = KEEP_DEFAULT) -> dict:
    """Capture locally, ship to <host>:<remote_root>, prune old copies there."""
    source = source.resolve(strict=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with tempfile.TemporaryDirectory(prefix=".polyd-push-", dir=str(source.parent)) as scratch:
        staged = Path(scratch) / stamp
        manifest = capture(source, staged)
        logger.info("captured %s files locally", len(manifest.get("files", {})))
        remote = f"{remote_root.rstrip('/')}/{stamp}"
        run = ssh(host, ["mkdir", "-p", remote])
        if run.returncode != 0:
            raise RuntimeError(f"remote mkdir failed: {run.stderr.strip()}")
        # tar over the ssh pipe: some hosts (rightly) disable the sftp subsystem,
        # which would leave rsync without a transport.
        tar = subprocess.Popen(["tar", "-C", str(staged), "-cf", "-", "."],
                               stdout=subprocess.PIPE)
        assert tar.stdout is not None
        untar = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                                host, "tar", "-C", remote, "-xf", "-"],
                               stdin=tar.stdout, capture_output=True, text=True, timeout=300)
        tar.stdout.close()
        tar.wait()
        if tar.returncode != 0 or untar.returncode != 0:
            raise RuntimeError(f"tar pipe failed: {untar.stderr.strip() or 'tar'}")
        # The local capture already verified the files; confirm the shipped
        # copy arrived complete by comparing the manifest checksum remotely.
        manifest_sha = (staged / "manifest.json").read_bytes()
        remote_manifest = ssh(host, ["cat", f"{remote}/manifest.json"])
        if remote_manifest.returncode != 0 or remote_manifest.stdout.encode() != manifest_sha:
            raise RuntimeError("remote manifest mismatch after rsync")
        prune(host, remote_root, keep)
    return manifest


def prune(host: str, remote_root: str, keep: int) -> None:
    run = ssh(host, ["ls", "-1", remote_root.rstrip("/")])
    if run.returncode != 0:
        return
    names = sorted(line.strip() for line in run.stdout.splitlines() if line.strip())
    for old in names[:-keep] if keep > 0 else names:
        ssh(host, ["rm", "-rf", f"{remote_root.rstrip('/')}/{old}"])
        logger.info("pruned remote copy %s", old)


def newest_snapshot(root: Path) -> Path | None:
    if not root.is_dir():
        return None
    candidates = sorted((p for p in root.iterdir() if p.is_dir() and (p / "manifest.json").is_file()),
                        key=lambda p: p.name)
    return candidates[-1] if candidates else None


def restore(snapshots: Path, target: Path, force: bool = False,
            allow_missing: bool = False, fencing_evidence: Path | None = None,
            evidence_max_age_s: float = 900, health_url: str | None = None) -> dict:
    """Adopt the newest verified snapshot into the target state directory.

    Holds the router's own lock (router.lock in the state directory, see
    tg-bot/bot/activation.py) for the whole restore and refuses when a router
    holds it or, with health_url, answers there: replacing DB/WAL/SHM files
    under an open SQLite database corrupts it.
    """
    if health_url and router_up(health_url, 4):
        raise PermissionError(f"a router answers at {health_url}; stop it before restoring")
    target.mkdir(parents=True, exist_ok=True)
    with (target / "router.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise PermissionError(f"router.lock in {target} is held: a router is running") from exc
        return _restore_locked(snapshots, target, force, allow_missing,
                               fencing_evidence, evidence_max_age_s)


def _restore_locked(snapshots: Path, target: Path, force: bool, allow_missing: bool,
                    fencing_evidence: Path | None, evidence_max_age_s: float) -> dict:
    snap = newest_snapshot(snapshots)
    if snap is None:
        if allow_missing:
            logger.warning("no snapshot under %s; keeping the local state as is", snapshots)
            return {}
        raise FileNotFoundError(f"no snapshot under {snapshots}")
    manifest = verify(snap)
    if any(p.name != "router.lock" for p in target.iterdir()):
        if not force:
            raise ValueError(f"target {target} is not empty; pass --force to overwrite")
        if fencing_evidence is None:
            raise PermissionError("--force overwrites live state; fencing evidence required")
        try:
            load_fencing_evidence(fencing_evidence, evidence_max_age_s)
        except ValueError as exc:
            raise PermissionError(f"refusing --force restore: {exc}") from exc
    for name in manifest["files"]:
        src, dst = snap / name, target / name
        # Drop stale SQLite sidecars first: leaving a foreign -wal/-shm beside a
        # restored database would make SQLite replay someone else's journal.
        for suffix in ("-wal", "-shm"):
            stale = target / (name + suffix)
            if stale.exists() or stale.is_symlink():
                stale.unlink()
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        with tempfile.NamedTemporaryFile(dir=str(target), delete=False) as tmp:
            shutil.copyfileobj(src.open("rb"), tmp)
            tmp_path = Path(tmp.name)
        tmp_path.chmod(0o600)
        tmp_path.replace(dst)
    logger.info("restored %s files from %s into %s", len(manifest["files"]), snap.name, target)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)

    p = sub.add_parser("push", help="capture state and ship it to the standby host")
    p.add_argument("source", type=Path)
    p.add_argument("--host", required=True)
    p.add_argument("--remote-root", required=True)
    p.add_argument("--keep", type=int, default=KEEP_DEFAULT)

    r = sub.add_parser("restore", help="adopt the newest snapshot into a state directory")
    r.add_argument("snapshots", type=Path)
    r.add_argument("target", type=Path)
    r.add_argument("--force", action="store_true")
    r.add_argument("--fencing-evidence", type=Path,
                   default=os.environ.get(EVIDENCE_ENV) or None,
                   help="fresh fencing attestation; required with --force on a populated "
                        f"target (default: ${EVIDENCE_ENV})")
    r.add_argument("--router-health-url",
                   help="refuse when a router answers here (e.g. http://127.0.0.1:8090/)")
    r.add_argument("--allow-missing", action="store_true",
                   help="succeed (leaving the target alone) when no snapshot exists yet")

    v = sub.add_parser("verify-snapshot", help="check the newest snapshot in place")
    v.add_argument("snapshots", type=Path)

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.action == "push":
        push(args.source, args.host, args.remote_root, args.keep)
    elif args.action == "restore":
        restore(args.snapshots, args.target, args.force, args.allow_missing,
                args.fencing_evidence, health_url=args.router_health_url)
    else:
        snap = newest_snapshot(args.snapshots)
        if snap is None:
            raise FileNotFoundError(f"no snapshot under {args.snapshots}")
        verify(snap)
        logger.info("snapshot %s verifies", snap.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
