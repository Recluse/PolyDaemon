"""Canonical launcher names and legacy discovery without opening windows."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LauncherNamesTest(unittest.TestCase):
    def test_discovery_and_launch_preference(self):
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "Project with spaces"
            workspace.mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            tmux = bin_dir / "tmux"
            tmux.write_text('#!/bin/sh\n[ "$1" = has-session ] && exit 1\nprintf "%s\\n" "$@" > "$CAPTURE"\n')
            tmux.chmod(0o755)
            capture = root / "args"
            env = dict(os.environ, PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                       TG_WORK_DIR=str(root), TG_MAC_TERMINAL="tmux", TG_MAC_NUDGE="0",
                       CAPTURE=str(capture))
            launcher = repo / "clients/launch-ws.sh"
            for names, expected in (
                (("tg-claude.sh",), "tg-claude.sh"),
                (("tg-claude.sh", "polydaemon-claude.sh"), "polydaemon-claude.sh"),
                (("polydaemon-claude.sh",), "polydaemon-claude.sh"),
            ):
                for old in workspace.iterdir():
                    old.unlink()
                for name in names:
                    (workspace / name).touch()
                listed = subprocess.run(["bash", str(launcher), "--list"], env=env,
                                        capture_output=True, text=True, check=True).stdout
                self.assertEqual(listed.count(str(workspace)), 1)
                for args in ([workspace.name], [workspace.name, str(workspace)]):
                    subprocess.run(["bash", str(launcher), *args], env=env,
                                   capture_output=True, text=True, check=True)
                    actual = capture.read_text().splitlines()
                    self.assertEqual(actual[-2:], [str(workspace), f"bash ./{expected}"])

    def test_root_copies_match_templates(self):
        repo = Path(__file__).resolve().parent.parent
        for agent in ("claude", "codex", "opencode", "mimo"):
            name = f"polydaemon-{agent}.sh"
            self.assertEqual((repo / name).read_bytes(), (repo / "clients" / name).read_bytes())
            self.assertTrue(os.access(repo / name, os.X_OK))


if __name__ == "__main__":
    unittest.main()
