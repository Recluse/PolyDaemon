#!/usr/bin/env python3
"""Forced SSH command for one bot's downloaded attachments; never runs a shell."""

import json
import os
from pathlib import Path, PurePosixPath
import shlex
import stat
import subprocess
import sys


KINDS = frozenset({
    "photos", "documents", "videos", "video_notes", "voice", "voices",
    "audios", "audio", "animations", "stickers", "thumbnails",
})


def attachment_parts(command, config):
    args = shlex.split(command)
    if len(args) != 5 or args[:4] != ["docker", "exec", config["container"], "cat"]:
        raise ValueError("unsupported command")
    prefix = "/var/lib/telegram-bot-api/" + config["bot_directory"] + "/"
    if not args[4].startswith(prefix):
        raise ValueError("outside bot directory")
    parts = args[4][len(prefix):].split("/")
    if (len(parts) < 2 or parts[0] not in KINDS
            or any(p in ("", ".", "..") or any(ord(c) < 32 for c in p) for p in parts)):
        raise ValueError("not an attachment")
    return parts


def open_regular(root, parts):
    """Resolve every component through dirfds, rejecting symlinks and devices."""
    base = PurePosixPath(root)
    if not base.is_absolute() or ".." in base.parts:
        raise ValueError("invalid root")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in (*base.parts[1:], *parts[:-1]):
            new_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new_fd
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        if not stat.S_ISREG(os.fstat(result).st_mode):
            os.close(result)
            raise ValueError("not a regular file")
        return result
    finally:
        os.close(fd)


def main():
    config_path = Path(__file__).with_suffix(".json")
    config = json.loads(config_path.read_text())
    directory = config["bot_directory"]
    if not directory or any(c in directory for c in "/\\\x00") or directory in (".", ".."):
        raise ValueError("invalid bot directory")
    if sys.argv[1:] == ["--inner"]:
        # Re-parse the original command inside Podman's UID namespace too.
        parts = attachment_parts(os.environ.get("SSH_ORIGINAL_COMMAND", ""), config)
        root = str(Path(config["volume_root"]) / directory)
        with os.fdopen(open_regular(root, parts), "rb") as source:
            while data := source.read(1024 * 1024):
                sys.stdout.buffer.write(data)
        return 0
    if sys.argv[1:]:
        raise ValueError("unexpected arguments")
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if command == "polydaemon-attachment-check":
        print('{"restricted_attachment_reader":1}')
        return 0
    attachment_parts(command, config)
    return subprocess.run([
        "/usr/bin/podman", "unshare", "/usr/bin/python3", "-I",
        str(Path(__file__).resolve()), "--inner",
    ], check=False).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError):
        # Paths can contain the bot token. Never include exceptions in output.
        print("Attachment read denied or unavailable", file=sys.stderr)
        sys.exit(1)
