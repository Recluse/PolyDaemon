"""Check launcher cwd, argument boundaries and CLI exit status without a model call."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


class OpenCodeLauncherTest(unittest.TestCase):
    def test_workspace_arguments_and_exit_status(self):
        launcher = Path(os.environ.get(
            "TG_OPENCODE_LAUNCHER", Path(__file__).with_name("polydaemon-opencode.sh")
        )).resolve()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            workspace = root / "Project # test & space"
            workspace.mkdir()
            copy = workspace / "polydaemon-opencode.sh"
            shutil.copyfile(launcher, copy)
            copy.chmod(0o755)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stub = bin_dir / "opencode"
            stub.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "args=sys.argv[1:]; cwd=os.getcwd()\n"
                "session={'id':'ses_saved','location':{'directory':cwd}}\n"
                "if 'session.list' in args:\n"
                " print(json.dumps({'data':[session] if os.environ['SAVED']=='1' else []}))\n"
                "elif 'session.get' in args: print(json.dumps({'data':session}))\n"
                "elif 'session.create' in args:\n"
                " session['id']='ses_new'; print(json.dumps({'data':session}))\n"
                "else:\n"
                " print(json.dumps({'cwd':cwd,'args':args,'root':os.environ.get('TG_OPENCODE_ROOT'),'session':os.environ.get('TG_OPENCODE_SESSION'),'agent':os.environ.get('TG_BRIDGE_AGENT'),'name':os.environ.get('TG_BRIDGE_INSTANCE_NAME'),'uid':bool(os.environ.get('TG_WINDOW_UID'))}))\n"
                " sys.exit(int(os.environ['TEST_EXIT']))\n"
            )
            stub.chmod(0o755)
            home = root / "home"
            config = home / ".config" / "polydaemon"
            config.mkdir(parents=True)
            (config / "machine.env").write_text('TG_BOT_TOKEN=test\nTG_BRIDGE_AUTH_TOKEN=test\n')
            repo = Path(__file__).resolve().parent.parent
            env = {**os.environ, "HOME": str(home), "TG_BRIDGE_REPO": str(repo),
                   "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]}
            for saved, fresh, code in ((False, False, 0), (True, False, 0), (True, True, 0), (False, False, 37)):
                args = ["--print-logs"]
                with self.subTest(saved=saved, fresh=fresh, code=code):
                    result = subprocess.run(
                        [str(copy), *args], cwd=root,
                        env={**env, "TEST_EXIT": str(code), "SAVED": str(int(saved)),
                             "TG_OPENCODE_NEW": str(int(fresh))}, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, code, result.stderr)
                    session = "ses_saved" if saved and not fresh else "ses_new"
                    self.assertEqual(json.loads(result.stdout), {
                        "cwd": str(workspace), "args": ["--standalone", "--session", session, *args, str(workspace)],
                        "root": str(workspace), "session": session, "agent": "opencode",
                        "name": workspace.name + "-opencode", "uid": True,
                    })
            (config / "repo-path").write_text(str(repo) + "\n")
            discovered = {k: v for k, v in env.items() if k != "TG_BRIDGE_REPO"}
            result = subprocess.run([str(copy)], cwd=root,
                env={**discovered, "TEST_EXIT": "0", "SAVED": "0", "TG_OPENCODE_NEW": "1"},
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["cwd"], str(workspace))
            (config / "repo-path").unlink()
            result = subprocess.run([str(copy)], cwd=root, env=discovered, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("hooks/install.py --mcp --opencode", result.stderr)
            registry = home / '.tg-bridge-channel'
            registry.mkdir()
            row = {"instance_name": workspace.name + '-opencode', "cwd": str(workspace),
                   "pid": os.getpid(), "parent_pid": 1, "heartbeat_at": time.time()}
            for parent, expected in ((1, 0), (os.getpid(), 1)):
                row['parent_pid'] = parent
                (registry / 'instances.json').write_text(json.dumps({'test': row}))
                result = subprocess.run([str(copy)], cwd=root,
                    env={**env, "TEST_EXIT": "0", "SAVED": "0", "TG_OPENCODE_NEW": "1"},
                    capture_output=True, text=True)
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected:
                    self.assertIn('already owns', result.stderr)


if __name__ == "__main__":
    unittest.main()
