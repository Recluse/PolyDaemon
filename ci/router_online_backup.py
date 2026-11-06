#!/usr/bin/env python3
"""Per-file recovery material, never an automatic failover checkpoint.

Run capture under an external process timeout: the cooperative SQLite deadline
does not bound filesystem IO or integrity verification. Only a successful exit
and a verified manifest constitute acceptance, never directory existence alone.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import tempfile
import time
from contextlib import closing
from pathlib import Path

DATABASES = ('bot.db', 'updates.db')
SIDECARS = ('topic-bindings.json', 'active-instances.json',
            'permission-overrides.json', 'default-instance.json')
MAX_JSON = 16 * 1024 * 1024


def stable_json(path: Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_JSON:
            raise ValueError('Invalid sidecar')
        data = stream.read(MAX_JSON + 1)
        after = os.fstat(stream.fileno())
    current = path.lstat()
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if len(data) > MAX_JSON or identity(before) != identity(after) or identity(after) != identity(current):
        raise ValueError('Sidecar changed during capture')
    json.loads(data)
    return data


def checksum(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(root: Path) -> dict:
    manifest = json.loads(stable_json(root / 'manifest.json'))
    if (manifest.get('version') != 1
            or manifest.get('consistency') != 'per_file_online'
            or manifest.get('cross_file_atomic') is not False
            or manifest.get('automatic_restore_allowed') is not False):
        raise ValueError('Invalid recovery contract')
    files = manifest.get('files')
    if not isinstance(files, dict) or not set(DATABASES).issubset(files) or set(files) - set(DATABASES + SIDECARS):
        raise ValueError('Invalid file inventory')
    for name, entry in files.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or checksum(path) != entry['sha256']:
            raise ValueError('Backup checksum mismatch')
        if name in DATABASES:
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('Backup integrity failure')
        else:
            stable_json(path)
    return manifest


def capture(source: Path, destination: Path, timeout: float = 60) -> dict:
    source = source.resolve(strict=True)
    destination = destination.absolute()
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if destination.exists() or destination.is_symlink() or destination.is_relative_to(source):
        raise ValueError('Destination must be new and outside state')
    deadline = time.monotonic() + timeout
    manifest = dict(version=1, consistency='per_file_online', cross_file_atomic=False,
                    automatic_restore_allowed=False, started_at=time.time(), files={})
    def progress(*_):
        if time.monotonic() >= deadline:
            raise TimeoutError('Backup deadline exceeded')
    with tempfile.TemporaryDirectory(prefix='.router-backup-', dir=parent) as scratch:
        stage = Path(scratch)
        for name in DATABASES + SIDECARS:
            progress()
            src, dst = source / name, stage / name
            if src.is_symlink():
                raise ValueError('Symlink state file')
            if name in SIDECARS and not src.exists():
                continue
            started = time.time()
            if name in DATABASES:
                identity = src.stat()
                if not stat.S_ISREG(identity.st_mode) or not identity.st_size:
                    raise ValueError('Missing database')
                dst.touch(mode=0o600, exist_ok=False)
                with closing(sqlite3.connect(src.as_uri() + '?mode=ro', uri=True, timeout=1)) as incoming:
                    with closing(sqlite3.connect(dst)) as outgoing:
                        incoming.backup(outgoing, pages=128, progress=progress, sleep=0.05)
                current = src.lstat()
                if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                    raise ValueError('Source database replaced')
            else:
                data = stable_json(src)
                with dst.open('xb') as stream:
                    os.chmod(dst, 0o600)
                    stream.write(data)
            manifest['files'][name] = dict(sha256=checksum(dst), started_at=started, ended_at=time.time())
        manifest['ended_at'] = time.time()
        path = stage / 'manifest.json'
        with path.open('x') as stream:
            os.chmod(path, 0o600)
            json.dump(manifest, stream, indent=2)
        verify(stage)
        progress()
        for path in stage.iterdir():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
        fd = os.open(stage, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        # Reserve the final name exclusively; publish only the complete directory.
        destination.mkdir(mode=0o700)
        try:
            os.rename(stage, destination)
        except BaseException:
            destination.rmdir()
            raise
        fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'verify'))
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path, nargs='?')
    args = parser.parse_args()
    if args.action == 'capture':
        if args.destination is None:
            parser.error('capture requires destination')
        result = capture(args.source, args.destination)
    else:
        result = verify(args.source.resolve(strict=True))
    print(json.dumps({'ok': True, 'consistency': result['consistency'], 'files': list(result['files'])}))


if __name__ == '__main__':
    main()
