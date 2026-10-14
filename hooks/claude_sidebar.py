"""Build a self-contained Claude mod bundle; install through the native CLI."""
from __future__ import annotations

import json
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from typing import Callable

MARKETPLACE = "polydaemon-sidebar"
PLUGIN = f"pd-sidebar@{MARKETPLACE}"


def build_bundle(repo: Path, target: Path, validate: Callable[[Path], None] | None = None) -> None:
    source = repo / "claude-mods/pd-sidebar"
    if not (source / ".claude-plugin/plugin.json").is_file():
        raise ValueError("Claude sidebar sources are missing")
    manifest = json.loads((source / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "pd-sidebar":
        raise ValueError("Unexpected sidebar plugin identity")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".sidebar-build-", dir=target.parent))
    try:
        plugin = staging / "pd-sidebar"
        shutil.copytree(source, plugin, ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__", "._*"))
        generated_types = plugin / ".claude-plugin/types"
        if generated_types.exists():
            shutil.rmtree(generated_types)
        for rel in ("clients/claude-status.cjs", "hooks/tg-bridge-locate.js"):
            dest = plugin / "assets" / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repo / rel, dest)
        catalog = staging / ".claude-plugin/marketplace.json"
        catalog.parent.mkdir()
        catalog.write_text(json.dumps({"name": MARKETPLACE, "owner": {"name": "PolyDaemon"},
                                      "plugins": [{"name": "pd-sidebar", "source": "./pd-sidebar"}]}, indent=2) + "\n", encoding="utf-8")
        if validate is not None:
            validate(plugin)
        if target.exists():
            if not (target / ".polydaemon-sidebar-bundle").is_file():
                raise ValueError("Refusing to replace an unowned sidebar directory")
            backup = target.with_name(target.name + ".bak-" + str(time.time_ns()))
            target.rename(backup)
        (staging / ".polydaemon-sidebar-bundle").write_text("1\n", encoding="ascii")
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main(repo: Path, args: list[str]) -> int:
    supported = {"--sidebar", "--dry-run", "--uninstall"}
    if any(arg not in supported for arg in args):
        print("--sidebar supports only --dry-run or --uninstall")
        return 2
    target = Path.home() / ".config/polydaemon/claude-sidebar"
    cli = shutil.which("claude") or "claude"
    commands = ([[cli, "plugin", "uninstall", PLUGIN, "--scope", "user"]] if "--uninstall" in args else [
        [cli, "plugin", "validate", str(target / "pd-sidebar")],
        [cli, "plugin", "marketplace", "add", str(target), "--scope", "user"],
        [cli, "plugin", "install", PLUGIN, "--scope", "user"],
    ])
    if "--dry-run" in args:
        print(json.dumps({"bundle": str(target), "commands": commands}, indent=2))
        return 0
    if not shutil.which("claude"):
        print("Claude CLI is not installed")
        return 1
    try:
        if "--uninstall" not in args:
            version = subprocess.run([cli, "--version"], check=True, timeout=15,
                                     capture_output=True, text=True)
            match = re.search(r"\b(\d+)\.(\d+)\.(\d+)\b", version.stdout)
            if not match or tuple(map(int, match.groups())) < (2, 1, 296):
                raise ValueError("Claude Code 2.1.296 or newer is required")
            build_bundle(repo, target, lambda plugin: subprocess.run(
                [cli, "plugin", "validate", str(plugin)], check=True, timeout=120))
        for command in commands:
            subprocess.run(command, check=True, timeout=120)
    except ValueError as error:
        print(f"Sidebar installation stopped: {error}")
        return 1
    except (OSError, subprocess.SubprocessError) as error:
        print(f"Sidebar installation incomplete ({type(error).__name__}); inspect the CLI output and retained bundle/backup.")
        return 1
    print("Sidebar plugin removed." if "--uninstall" in args else
          "Sidebar plugin updated. Use /reload-plugins in Claude or start the next session. No windows were restarted.")
    return 0
