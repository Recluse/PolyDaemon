"""Check a clean public tree with isolated test homes and no production credentials."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    repo = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="polydaemon-check-") as tmp:
        scratch = Path(tmp)
        source = repo
        if (repo / "oss/export.sh").exists():
            source = scratch / "public"
            subprocess.run(["bash", str(repo / "oss/export.sh"), str(source)], cwd=repo, check=True)
        subprocess.run(["gitleaks", "dir", "--redact", "--no-banner", str(source)], check=True)
        subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=source / "channel-plugin", check=True)
        commands = [
            ["node", "hooks/tg-approve.js", "--self-check"],
            ["node", "hooks/tg-bridge-locate.test.js"],
            [sys.executable, "hooks/install.py", "--self-check"],
            [sys.executable, "tg-bot/bot/http_registry.py"],
        ]
        commands += [["bun", "test", str(p.relative_to(source))]
                     for folder in ("agent", "channel-plugin/src", "clients")
                     for p in sorted((source / folder).glob("*.test.ts"))]
        commands += [[sys.executable, str(p.relative_to(source))]
                     for folder in ("tg-bot", "hooks", "clients")
                     for p in sorted((source / folder).glob("test_*.py"))]
        for i, command in enumerate(commands):
            home = scratch / f"home-{i}"
            home.mkdir()
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(("TG_", "CLAUDE_", "CODEX_", "GITLEAKS_"))}
            env.update(HOME=str(home), USERPROFILE=str(home), PYTHONPATH=str(source / "tg-bot"),
                       TG_BOT_TOKEN="fixture", TG_BRIDGE_AUTH_TOKEN="fixture",
                       TG_BRIDGE_BOT_URL="http://127.0.0.1:9", TG_API_ROOT="http://127.0.0.1:9")
            print("CHECK", " ".join(command), flush=True)
            subprocess.run(command, cwd=source, env=env, check=True, timeout=120)
        print(f"PASS: secret scan and {len(commands)} isolated checks", flush=True)


if __name__ == "__main__":
    main()
