#!/usr/bin/env python3
"""Offline router-state snapshot with SQLite backup and content verification.

The caller must stop/fence every state writer first. A lock alone cannot prove
that an older router (without the lock protocol) has stopped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tg-bot'))
from bot.activation import router_guard

DATABASES = ('bot.db', 'updates.db')
SIDECARS = ('topic-bindings.json', 'active-instances.json',
            'permission-overrides.json', 'default-instance.json')
FILES = DATABASES + SIDECARS


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(root: Path) -> dict:
    manifest = json.loads((root / 'manifest.json').read_text())
    entries = manifest.get('files')
    if manifest.get('version') != 1 or not isinstance(entries, dict) or 'bot.db' not in entries:
        raise ValueError('Invalid state manifest')
    if set(entries) - set(FILES):
        raise ValueError('Unexpected file in state manifest')
    for name, expected in entries.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError(f'Checksum mismatch: {name}')
        if name in DATABASES:
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError(f'SQLite integrity check failed: {name}')
        else:
            json.loads(path.read_text())
    return manifest


def snapshot(source: Path, destination: Path) -> dict:
    source = source.resolve(strict=True)
    destination = destination.absolute()
    if not (source / 'bot.db').is_file() or (source / 'bot.db').stat().st_size == 0:
        raise ValueError('Missing/empty authoritative bot.db')
    if destination.is_relative_to(source):
        raise ValueError('Snapshot must be outside the source state directory')
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    with router_guard(source, None, None):
        for name in FILES:
            src, dst = source / name, destination / name
            if src.is_symlink():
                raise ValueError(f'Symlink is not a state file: {name}')
            if not src.exists():
                continue
            if name in DATABASES:
                with closing(sqlite3.connect(src.as_uri() + '?mode=ro', uri=True)) as incoming:
                    with closing(sqlite3.connect(dst)) as outgoing:
                        incoming.backup(outgoing)
            else:
                json.loads(src.read_text())
                shutil.copyfile(src, dst)
            dst.chmod(0o600)
        manifest = {'version': 1, 'files': {name: digest(destination / name)
                                          for name in FILES if (destination / name).exists()}}
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (destination / 'manifest.json').chmod(0o600)
        verify(destination)
        for path in destination.iterdir():
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    capture = sub.add_parser('snapshot')
    capture.add_argument('source', type=Path)
    capture.add_argument('destination', type=Path)
    capture.add_argument('--writers-stopped', action='store_true', required=True)
    check = sub.add_parser('verify')
    check.add_argument('directory', type=Path)
    args = parser.parse_args()
    manifest = (snapshot(args.source, args.destination) if args.action == 'snapshot'
                else verify(args.directory.resolve(strict=True)))
    print(json.dumps({'ok': True, 'files': list(manifest['files'])}))


if __name__ == '__main__':
    main()
