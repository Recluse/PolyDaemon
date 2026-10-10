"""Native Windows cmd/PowerShell launcher checks, without model/daemon calls."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent


@unittest.skipUnless(os.name == 'nt', 'requires native Windows cmd and PowerShell 7')
class WindowsLaunchers(unittest.TestCase):
    def test_new_default_conflicts_and_workspace_quoting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'Project # test & space'
            workspace.mkdir()
            profile = root / 'profile'
            encoded = str(workspace).replace(':', '-').replace('\\', '-')
            history = profile / '.claude' / 'projects' / encoded / 'session.jsonl'
            history.parent.mkdir(parents=True)
            history.write_text('preserved history')
            env = {**os.environ, 'USERPROFILE': str(profile), 'TG_BRIDGE_REPO': str(REPO)}
            env.pop('TG_MIMO_NEW', None)
            env.pop('TG_OPENCODE_NEW', None)
            for agent in ('claude', 'codex', 'opencode', 'mimo'):
                launcher = workspace / f'polydaemon-{agent}.cmd'
                shutil.copyfile(REPO / launcher.name, launcher)
                def run(*args):
                    command = subprocess.list2cmdline([str(launcher), *args])
                    return subprocess.run(f'cmd.exe /d /s /c "{command}"',
                                          env=env, capture_output=True, text=True)
                with self.subTest(agent=agent):
                    fresh = run('new', '-Plan')
                    self.assertEqual(fresh.returncode, 0, fresh.stderr)
                    plan = json.loads(fresh.stdout)
                    self.assertTrue(plan['fresh'])
                    self.assertEqual(plan['workspace'], str(workspace))
                    self.assertNotIn('--continue', plan['arguments'])
                    self.assertNotIn(None, plan['arguments'])
                    if agent != 'codex':
                        self.assertNotIn('new', plan['arguments'])
                    if agent in ('mimo', 'opencode'):
                        self.assertEqual(plan[agent + 'New'], '1')
                    if agent != 'mimo':
                        forwarded = run('new', '-Plan', '--model', 'test-model')
                        self.assertEqual(forwarded.returncode, 0, forwarded.stderr)
                        self.assertEqual(json.loads(forwarded.stdout)['arguments'][-2:], ['--model', 'test-model'])
                    default = run('-Plan')
                    self.assertEqual(default.returncode, 0, default.stderr)
                    plan = json.loads(default.stdout)
                    self.assertFalse(plan['fresh'])
                    if agent == 'claude':
                        self.assertIn('--continue', plan['arguments'])
                    for conflict in ('resume', '--session=ses_123', '--continue', '-r', 'fork', '--fork-session'):
                        self.assertNotEqual(run('new', '-Plan', conflict).returncode, 0)
            self.assertEqual(history.read_text(), 'preserved history')

    def test_direct_codex_conflict_before_daemon_or_cli(self):
        result = subprocess.run(['pwsh.exe', '-NoProfile', '-File',
                                 str(REPO / 'clients/polydaemon-codex.ps1'),
                                 '-Workspace', str(REPO), 'new', 'resume'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('new cannot be combined', result.stderr)

    def test_direct_codex_consumes_new(self):
        result = subprocess.run(['pwsh.exe', '-NoProfile', '-File',
                                 str(REPO / 'clients/polydaemon-codex.ps1'),
                                 '-Workspace', str(REPO), '-Plan', 'new', '--model', 'test-model'],
                                capture_output=True, text=True, check=True)
        plan = json.loads(result.stdout)
        self.assertTrue(plan['fresh'])
        self.assertNotIn('new', plan['arguments'])
        self.assertEqual(plan['arguments'][-2:], ['--model', 'test-model'])

    def test_actual_command_dispatch_with_stubs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'Actual Project & spaces'
            workspace.mkdir()
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            capture = bin_dir / 'capture.py'
            capture.write_text("import json,os,sys; print(json.dumps({'args':sys.argv[1:],'cwd':os.getcwd(),'mimo':os.environ.get('TG_MIMO_NEW'),'opencode':os.environ.get('TG_OPENCODE_NEW')}))")
            for cli in ('claude', 'bun', 'codex'):
                (bin_dir / f'{cli}.cmd').write_text(f'@echo off\n"{sys.executable}" "{capture}" %*\n')
            native = bin_dir / 'node_modules/@openai/codex/vendor/codex.exe'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'test only')
            profile = root / 'profile'
            state = profile / '.tg-bridge'
            state.mkdir(parents=True)
            (state / 'agent.toml').write_text('auth_token = "test-token"\n')
            env = {**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],
                   'USERPROFILE':str(profile),'TG_BRIDGE_REPO':str(REPO)}
            for agent in ('claude','opencode','mimo'):
                launcher = workspace / f'polydaemon-{agent}.cmd'
                shutil.copyfile(REPO / launcher.name, launcher)
                command = subprocess.list2cmdline([str(launcher),'new'])
                result = subprocess.run(f'cmd.exe /d /s /c "{command}"',env=env,capture_output=True,text=True,check=True)
                call = json.loads(result.stdout)
                self.assertEqual(call['cwd'],str(workspace))
                self.assertNotIn('new',call['args'])
                self.assertNotIn('--continue',call['args'])
                if agent in ('opencode','mimo'):
                    self.assertEqual(call[agent],'1')
                    self.assertTrue(call['args'][1].endswith(f'{agent}-launch.ts'))
            harness = root / 'codex-harness.ps1'
            harness.write_text("function Invoke-RestMethod { param($Uri,$Headers,$TimeoutSec); if ($Uri -like '*/health') { return @{ok=$true} }; return @{app_server='up'} }\n"
                               + f"& '{REPO / 'clients/polydaemon-codex.ps1'}' -Workspace '{workspace}' new --model test-model\n")
            result = subprocess.run(['pwsh.exe','-NoProfile','-File',str(harness)],env=env,capture_output=True,text=True,check=True)
            call = json.loads(result.stdout)
            self.assertEqual(call['args'],['--remote','ws://127.0.0.1:3210','--cd',str(workspace),'--model','test-model'])


if __name__ == '__main__':
    unittest.main()
