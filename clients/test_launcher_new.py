"""Shared new-session CLI contract, with stub agents and no live sessions."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


class NewSessionTest(unittest.TestCase):
    def test_new_for_each_agent(self):
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            workspace = root / "Project with spaces"
            workspace.mkdir()
            home = root / "home"
            (home / ".tg-bridge").mkdir(parents=True)
            (home / ".tg-bridge/agent.toml").write_text('auth_token = "fixture"\nport = 3200\n')
            history = home / ".claude/projects" / re.sub(r"[^a-zA-Z0-9]", "-", str(workspace))
            history.mkdir(parents=True)
            transcript = history / "saved.jsonl"
            transcript.write_text("saved history\n")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stub = (
                f"#!{sys.executable}\n"
                "import json,os,sys\n"
                "from pathlib import Path\n"
                "name=Path(sys.argv[0]).name\n"
                "if name=='curl':\n"
                " if any('/last-thread' in a for a in sys.argv): print('{\"thread_id\":\"saved\"}')\n"
                "else: print(json.dumps({'args':sys.argv[1:],'cwd':os.getcwd(),"
                "'fresh':os.environ.get('TG_'+os.environ['AGENT'].upper()+'_NEW','0')}))\n"
            )
            for command in ("curl", "codex", "claude", "bun", "tmux"):
                target = bin_dir / command
                target.write_text(stub)
                target.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if not k.startswith("TG_") and k != "TMUX"}
            env.update(HOME=str(home), TMPDIR=str(root), TG_TMUX="0", TG_KEEP_AUTOCOMPACT="1",
                       TG_BRIDGE_REPO=str(repo), PATH=str(bin_dir) + os.pathsep + env["PATH"])
            for agent in ("codex", "claude", "opencode", "mimo"):
                target = workspace / f"polydaemon-{agent}.sh"
                shutil.copyfile(repo / "clients" / target.name, target)
                for fresh in (False, True):
                    with self.subTest(agent=agent, fresh=fresh):
                        args = (["new"] if fresh else []) + ["--model", "fixture model"]
                        result = subprocess.run(["bash", str(target), *args], cwd=root,
                                                env={**env, "AGENT": agent}, text=True, capture_output=True, check=True)
                        call = json.loads(result.stdout.splitlines()[-1])
                        self.assertEqual(call["cwd"], str(workspace))
                        self.assertEqual(call["fresh"], "1" if fresh else "0")
                        self.assertNotIn("new", call["args"])
                        self.assertEqual(call["args"][-2:], ["--model", "fixture model"])
                        if agent == "claude":
                            self.assertEqual("--continue" in call["args"], not fresh)
                        if agent == "codex":
                            self.assertEqual("resume" in call["args"], not fresh)
                conflict = ["resume", "saved"] if agent == "codex" else ["--resume", "saved"] if agent == "claude" else ["--session", "ses_saved"]
                rejected = subprocess.run(["bash", str(target), "new", *conflict], cwd=root,
                                          env={**env, "AGENT": agent}, text=True, capture_output=True)
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
            # A fresh Claude launch must not reattach an existing tmux session.
            result = subprocess.run(["bash", str(workspace / "polydaemon-claude.sh"), "new"],
                                    env={**env, "AGENT": "claude", "TG_TMUX": "1"},
                                    text=True, capture_output=True, check=True)
            call = json.loads(result.stdout)
            self.assertNotIn("-A", call["args"])
            self.assertEqual(call["fresh"], "1")
            self.assertEqual(transcript.read_text(), "saved history\n")


if __name__ == "__main__":
    unittest.main()
