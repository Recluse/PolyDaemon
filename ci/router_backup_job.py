#!/usr/bin/env python3
"""Bounded, single-run local recovery-material job; no automatic restore."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

from router_online_backup import stable_json

MARKER = '.polydaemon-online-backups'
ROOT_CAP = 1024 ** 3
MIN_FREE = 2 * 1024 ** 3


def capacity_guard(source: Path, root: Path) -> None:
    usage = 0
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            info = (Path(parent) / name).lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('Unexpected symlink in managed root')
            usage += info.st_size
    estimate = sum(path.stat().st_size for path in source.iterdir()
                   if path.is_file() and not path.is_symlink()
                   and (path.name.endswith(('.db', '.db-wal', '.json'))))
    if usage + 2 * estimate >= ROOT_CAP:
        raise ValueError('Backup capacity exceeded; inspect retained copies and incomplete residues')
    if shutil.disk_usage(root).free < max(MIN_FREE, 2 * estimate):
        raise ValueError('Insufficient free space; backup skipped')


def initialize(root: Path) -> None:
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    (root / MARKER).write_text('1\n')
    (root / MARKER).chmod(0o600)


def run_job(source: Path, root: Path, keep: int = 24, timeout: float = 90) -> dict:
    if keep < 1 or timeout <= 0:
        raise ValueError('Invalid job limits')
    if root.is_symlink() or root.stat().st_mode & 0o077:
        raise ValueError('Backup root must be private')
    if (root / MARKER).is_symlink() or (root / MARKER).read_text() != '1\n':
        raise ValueError('Not a managed backup root')
    root = root.resolve(strict=True)
    if root.is_relative_to(source.resolve(strict=True)):
        raise ValueError('Backup root must be outside state')
    fd = os.open(root / '.job.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        capacity_guard(source, root)
        name = 'online-' + uuid.uuid4().hex
        destination = root / name
        helper = Path(__file__).with_name('router_online_backup.py')
        for arguments in [('capture', str(source.resolve()), str(destination)), ('verify', str(destination))]:
            subprocess.run([sys.executable, str(helper), *arguments], timeout=timeout,
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        receipt = dict(version=1, completed_at=time.time(), directory=name,
                       consistency='per_file_online', automatic_restore_allowed=False)
        with (destination / 'job-receipt.json').open('x') as stream:
            os.chmod(stream.name, 0o600)
            json.dump(receipt, stream)
            stream.flush()
            os.fsync(stream.fileno())
        # Only this job's successful, marked copies participate in retention.
        accepted = []
        for path in root.iterdir():
            if path.is_symlink() or not path.is_dir() or not path.name.startswith('online-'):
                continue
            try:
                uuid.UUID(hex=path.name.removeprefix('online-'))
                entry = json.loads(stable_json(path / 'job-receipt.json'))
                if (entry.get('version') != 1 or entry.get('directory') != path.name
                        or entry.get('consistency') != 'per_file_online'
                        or entry.get('automatic_restore_allowed') is not False):
                    continue
                accepted.append((float(entry['completed_at']), path))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        accepted.sort(key=lambda item: item[0], reverse=True)
        for _, path in accepted[keep:]:
            if path != destination:
                shutil.rmtree(path)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('root', type=Path)
    parser.add_argument('--initialize', action='store_true')
    parser.add_argument('--keep', type=int, default=24)
    args = parser.parse_args()
    if args.initialize:
        initialize(args.root)
    receipt = run_job(args.source, args.root, args.keep)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
