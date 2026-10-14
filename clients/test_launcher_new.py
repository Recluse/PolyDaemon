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
                " if os.environ.get('HTTP_FAIL'): sys.exit(7)\n"
                " if any('/last-thread' in a for a in sys.argv): print(os.environ.get('THREAD_RESPONSE','{\"thread_id\": \"saved\"}'))\n"
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
                for conflict in (['resume', 'saved'], ['--session=ses_saved'], ['--fork-session'], ['--resume', 'saved']):
                    for selector in ('literal', 'environment'):
                        rejected = subprocess.run(["bash", str(target), *(['new'] if selector == 'literal' else []), *conflict], cwd=root,
                            env={**env, "AGENT": agent, f'TG_{agent.upper()}_NEW': '1' if selector == 'environment' else '0'},
                            text=True, capture_output=True)
                        self.assertEqual(rejected.returncode, 2, rejected.stderr)
                result = subprocess.run(['bash', str(target), 'new', '--model', 'resume'],
                    env={**env, 'AGENT': agent}, text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(result.stdout)['args'][-2:], ['--model', 'resume'])
            for agent, args in (('codex', ['resume', 'explicit-thread']), ('claude', ['--resume', 'explicit-thread'])):
                result = subprocess.run(['bash', str(workspace / f'polydaemon-{agent}.sh'), *args],
                    env={**env, 'AGENT': agent}, text=True, capture_output=True, check=True)
                actual = json.loads(result.stdout.splitlines()[-1])['args']
                self.assertNotIn('saved', actual)
                self.assertNotIn('--continue', actual)
                self.assertEqual(actual[-2:], args)
            for flag in ('-c', '-s'):
                result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh'), 'new', flag, 'fixture'],
                    env={**env, 'AGENT': 'codex'}, text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(result.stdout)['args'][-2:], [flag, 'fixture'])
            result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh'), '-m', 'fixture', 'resume', 'explicit-thread'],
                env={**env, 'AGENT': 'codex'}, text=True, capture_output=True, check=True)
            self.assertNotIn('saved', json.loads(result.stdout)['args'])
            result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh'), '--version'],
                env={**env, 'AGENT': 'codex', 'HTTP_FAIL': '1'}, text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout)['args'], ['--cd', str(workspace), '--version'])
            for response in ('not JSON', '{}', 'null', '{"thread_id":42}', '{"thread_id":"bad/path"}', '{"ok":false,"thread_id":null}'):
                result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh')],
                    env={**env, 'AGENT': 'codex', 'THREAD_RESPONSE': response}, text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('invalid last-thread response', result.stderr)
            for response in ('{"thread_id":null}', '{"thread_id":""}'):
                result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh')],
                    env={**env, 'AGENT': 'codex', 'THREAD_RESPONSE': response}, text=True, capture_output=True, check=True)
                self.assertNotIn('resume', json.loads(result.stdout)['args'])
            result = subprocess.run(['bash', str(workspace / 'polydaemon-codex.sh'), 'new'],
                env={**env, 'AGENT': 'codex', 'TG_CODEX_CHECK_UPDATE': '0'}, text=True, capture_output=True, check=True)
            self.assertIn('check_for_update_on_startup=false', json.loads(result.stdout)['args'])
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
