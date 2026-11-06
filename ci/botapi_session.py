#!/usr/bin/env python3
"""Restore one closed Bot API session inside the target UID namespace.

The operator must fence all callers and close the old session first. This
offline helper does not contact Telegram, stop services, or prove fencing.
"""
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def validate(tar, directory):
    if (not directory or directory in ('.', '..')
            or any(c in directory for c in '/\\')
            or any(ord(c) < 32 for c in directory)):
        raise ValueError('Invalid session directory')
    seen = set()
    members = tar.getmembers()
    if not members:
        raise ValueError('Empty session archive')
    for member in members:
        parts = member.name.rstrip('/').split('/')
        if (not parts or parts[0] != directory
                or any(p in ('', '.', '..') for p in parts)
                or '\\' in member.name or any(ord(c) < 32 for c in member.name)
                or not (member.isfile() or member.isdir())
                or member.size < 0 or (len(parts) == 1 and not member.isdir())):
            raise ValueError('Invalid session archive member')
        key = str(PurePosixPath(*parts))
        if key in seen:
            raise ValueError('Duplicate session archive member')
        seen.add(key)
    return members


def restore(archive, volume, directory, uid, gid):
    volume = Path(volume)
    if volume.is_symlink() or not volume.is_dir():
        raise ValueError('Invalid target volume')
    with tarfile.open(archive) as tar:
        members = validate(tar, directory)
        target = volume / directory
        if target.exists() or target.is_symlink():
            raise ValueError('Session already exists; refusing overwrite')
        required = sum(m.size for m in members if m.isfile())
        if shutil.disk_usage(volume).free < required + 16 * 1024 * 1024:
            raise ValueError('Insufficient target free space')
        # Reserve a new private subtree. No pre-existing files are modified.
        target.mkdir(mode=0o700)
        tar.extractall(volume, members=members, filter='data')
        for parent, dirs, files in os.walk(target):
            os.chmod(parent, 0o700)
            os.chown(parent, uid, gid)
            for name in files:
                path = Path(parent) / name
                os.chmod(path, 0o600)
                os.chown(path, uid, gid)
        for parent, dirs, files in os.walk(target):
            for path in [Path(parent), *(Path(parent) / name for name in files)]:
                info = path.stat()
                if (info.st_uid, info.st_gid) != (uid, gid):
                    raise ValueError('Session ownership verification failed')
        return {'files': sum(m.isfile() for m in members), 'bytes': required}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('volume', type=Path)
    parser.add_argument('--uid', type=int, required=True)
    parser.add_argument('--gid', type=int, required=True)
    args = parser.parse_args()
    if args.uid < 0 or args.gid < 0:
        raise ValueError('Invalid target identity')
    directory = sys.stdin.read().rstrip('\n')
    result = restore(args.archive, args.volume, directory, args.uid, args.gid)
    print(f"Session restored: {result['files']} files, {result['bytes']} bytes")


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, tarfile.TarError):
        # Archive paths may contain the token; never print their exceptions.
        sys.exit('Session restore failed; private details withheld')
