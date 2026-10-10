"""Native launch-ws planning/ownership tests; never open or control a window."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / 'launch-ws.ps1'
HOST = os.environ.get('POLYDAEMON_LAUNCH_HOST', 'powershell.exe')


@unittest.skipUnless(os.name == 'nt', 'native Windows required')
class LaunchWorkspace(unittest.TestCase):
    def run_plan(self, folder, profile, *args):
        return subprocess.run([HOST, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT), 'supplied-name',
                               '-Dir', str(folder), '-Check', *args],
                              env={**os.environ, 'USERPROFILE': str(profile)},
                              capture_output=True, text=True)

    def test_exact_workspace_agents_and_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'Project # space & test'
            folder.mkdir()
            profile = root / 'profile'
            for agent in ('claude', 'codex', 'opencode', 'mimo'):
                (folder / f'polydaemon-{agent}.cmd').write_text('@echo off\n')
                for fresh in (False, True):
                    result = self.run_plan(folder, profile, '-Agent', agent, *(['-NewSession'] if fresh else []))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    plan = json.loads(result.stdout)
                    self.assertEqual(plan['workspace'], str(folder))
                    self.assertEqual(plan['agent'], agent)
                    self.assertEqual(plan['launcher'], str(folder / f'polydaemon-{agent}.cmd'))
                    self.assertEqual(plan['new_session'], fresh)
                    self.assertEqual('new' in plan['arguments'], fresh)
                    self.assertEqual(plan['nudge'], agent == 'claude')
                    self.assertEqual('--settings' in plan['arguments'], agent == 'claude')
            self.assertFalse((profile / '.tg-bridge-channel' / 'launch-no-autocompact.json').exists(), 'Check must not write settings')
            missing = self.run_plan(root / 'absent', profile, '-Agent', 'codex')
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn('Exact workspace', missing.stderr)

    def test_legacy_only_claude_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'tg-claude.cmd').write_text('@echo off\n')
            self.assertEqual(self.run_plan(folder, folder / 'profile').returncode, 0)
            self.assertNotEqual(self.run_plan(folder, folder / 'profile', '-NewSession').returncode, 0)
            self.assertNotEqual(self.run_plan(folder, folder / 'profile', '-Agent', 'mimo').returncode, 0)

    def test_ownership_is_agent_specific(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'Project'
            folder.mkdir()
            for agent in ('codex','mimo'):
                (folder / f'polydaemon-{agent}.cmd').write_text('@echo off\n')
            profile = Path(tmp) / 'profile'
            state = profile / '.tg-bridge-channel'
            state.mkdir(parents=True)
            registry = state / 'instances.json'
            row = {'instance_name':'Project-codex','cwd':str(folder),'pid':os.getpid(),'parent_pid':os.getpid()}
            registry.write_text(json.dumps({'local':row}))
            blocked = self.run_plan(folder, profile, '-Agent','codex')
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn('live codex bridge window', blocked.stderr)
            allowed = self.run_plan(folder, profile, '-Agent','mimo','-NewSession')
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertEqual(json.loads(allowed.stdout)['agent'],'mimo')
            self.assertEqual(json.loads(registry.read_text())['local'],row)

    def test_non_claude_actual_spawn_has_no_key_injection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'Spawn # space & test'
            folder.mkdir()
            for agent in ('codex','opencode','mimo'):
                (folder / f'polydaemon-{agent}.cmd').write_text('@echo off\n')
                record = root / 'spawn.json'
                harness = root / 'harness.ps1'
                harness.write_text(
                    "function Add-Type { throw 'Unexpected non-Claude native key/window manipulation' }\n"
                    "function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru); "
                    + f"@{{exe=$FilePath;args=$ArgumentList;cwd=$WorkingDirectory;style=$WindowStyle}} | ConvertTo-Json | Set-Content -LiteralPath '{record}'; "
                    "return [pscustomobject]@{Id=12345} }\n"
                    + f"& '{SCRIPT}' -Dir '{folder}' -Agent {agent} -NewSession -NoMinimize\n")
                result = subprocess.run([HOST,'-NoProfile','-ExecutionPolicy','Bypass','-File',str(harness)],
                                        env={**os.environ,'USERPROFILE':str(root/'profile')},
                                        capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                call = json.loads(record.read_text(encoding='utf-8-sig'))
                self.assertEqual(call['exe'],'cmd.exe')
                self.assertEqual(call['cwd'],str(folder))
                self.assertEqual(call['style'],'Normal')
                self.assertIn(f'polydaemon-{agent}.cmd',call['args'])
                self.assertIn('"new"',call['args'])
                self.assertNotIn('--settings',call['args'])


if __name__ == '__main__':
    unittest.main()
