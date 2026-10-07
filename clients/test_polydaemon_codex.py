"""Launcher check; TG_CODEX_LAUNCHER optionally selects an installed copy."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class CodexLauncherTest(unittest.TestCase):
    def test_remote_workspace_for_new_and_resumed_sessions(self):
        launcher = Path(os.environ.get("TG_CODEX_LAUNCHER", Path(__file__).with_name("polydaemon-codex.sh")))
        for resume, fresh in (("", False), ("known-thread", False), ("known-thread", True)):
            with self.subTest(resume=resume, fresh=fresh), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                workspace = root / "Project # test & space"
                workspace.mkdir()
                shutil.copyfile(launcher, workspace / "polydaemon-codex.sh")
                home = root / "home"
                config = home / ".tg-bridge"
                config.mkdir(parents=True)
                (config / "agent.toml").write_text(
                    'auth_token = "test-token"\nport = 3200\n'
                )
                bin_dir = root / "bin"
                bin_dir.mkdir()
                # Record the real argv seen by the remote CLI and curl.
                stub = (
                    f"#!{sys.executable}\n"
                    "import json, os, pathlib, sys\n"
                    "if pathlib.Path(sys.argv[0]).name == 'codex':\n"
                    " print(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd()}))\n"
                    "elif any('/last-thread' in a for a in sys.argv):\n"
                    " pathlib.Path(os.environ['QUERY_LOG']).write_text(json.dumps(sys.argv[1:]))\n"
                    " print(json.dumps({'thread_id': os.environ['TEST_RESUME']}, separators=(',', ':')))\n"
                )
                for name in ("curl", "codex"):
                    exe = bin_dir / name
                    exe.write_text(stub)
                    exe.chmod(0o755)
                env = {
                    **os.environ, "HOME": str(home),
                    "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                    "TEST_RESUME": resume, "QUERY_LOG": str(root / "query.json"),
                    "TG_CODEX_WS_PORT": "3210",
                    "TG_CODEX_NEW": "1" if fresh else "0",
                }
                result = subprocess.run(
                    ["bash", str(workspace / "polydaemon-codex.sh"), "--model", "test-model"],
                    cwd=root, env=env, text=True, capture_output=True, check=True,
                )
                call = json.loads(result.stdout.splitlines()[-1])
                expected = ["--remote", "ws://127.0.0.1:3210"]
                if resume and not fresh:
                    expected += ["resume", resume]
                expected += ["--cd", str(workspace), "--model", "test-model"]
                self.assertEqual(call, {"args": expected, "cwd": str(workspace)})
                query_log = root / "query.json"
                if fresh:
                    self.assertFalse(query_log.exists())
                else:
                    query = json.loads(query_log.read_text())
                    self.assertIn("--get", query)
                    self.assertEqual(
                        query[query.index("--data-urlencode") + 1], f"cwd={workspace}"
                    )


if __name__ == "__main__":
    unittest.main()
