"""Startup key decisions against scripted tmux screens, never a real agent."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
TRUST_NO = '  \u276f 1. No, exit\n    2. Yes, I trust this folder\nEnter to confirm'
TRUST_YES = '    1. No, exit\n  \u276f 2. Yes, I trust this folder\nEnter to confirm'
CHANNELS = '  \u276f 1. I am using this for local development\n    2. Exit\nEnter to confirm'


@unittest.skipIf(os.name == 'nt', 'POSIX launcher')
class StartupSelection(unittest.TestCase):
    def run_screens(self, screens, expected, gone=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'project'
            workspace.mkdir()
            (workspace / 'polydaemon-claude.sh').write_text('exit 99\n')
            fixture = root / 'fixture.json'
            fixture.write_text(json.dumps({'screens': screens, 'gone': gone}))
            bindir = root / 'bin'
            bindir.mkdir()
            tmux = bindir / 'tmux'
            # Shell fixture keeps only its own state; new-session never launches.
            tmux.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['NUDGE_FIXTURE'])
d = json.loads(p.read_text())
args = sys.argv[1:]
action = args[0]
if action == 'has-session':
    sys.exit(0 if d.get('started') and not d.get('gone') else 1)
if action == 'new-session':
    d['started'] = True
elif action == 'capture-pane':
    if d.get('gone'):
        sys.exit(1)
    i = d.get('index', 0)
    print(d['screens'][min(i, len(d['screens']) - 1)])
    d['index'] = i + 1
elif action == 'send-keys':
    d.setdefault('keys', []).append(args[-1])
else:
    sys.exit(2)
p.write_text(json.dumps(d))
''')
            tmux.chmod(0o755)
            sleep = bindir / 'sleep'
            sleep.write_text('#!/bin/sh\nexit 0\n')
            sleep.chmod(0o755)
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(('TG_', 'CLAUDE', 'CODEX', 'MIMOCODE', 'TMUX'))}
            env.update(HOME=str(root), USERPROFILE=str(root),
                       PATH=str(bindir) + os.pathsep + os.environ['PATH'],
                       TG_MAC_TERMINAL='tmux', TG_MAC_NUDGE='1',
                       NUDGE_FIXTURE=str(fixture))
            result = subprocess.run(['bash', str(ROOT / 'clients/launch-ws.sh'),
                                     'project', str(workspace), 'claude', 'new'],
                                    env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 1 if gone else 0, result.stderr)
            self.assertEqual(json.loads(fixture.read_text()).get('keys', []), expected)
            if gone:
                self.assertNotIn('launched', result.stdout)
                self.assertIn('exited during startup', result.stderr)

    def test_lost_down_then_positive_selection(self):
        self.run_screens([TRUST_NO, TRUST_NO, TRUST_YES, TRUST_YES,
                          CHANNELS, CHANNELS, 'bypass permissions on'],
                         ['Down', 'Down', 'Enter', 'Enter'])

    def test_already_selected_does_not_toggle_to_exit(self):
        self.run_screens([TRUST_YES, TRUST_YES, 'bypass permissions on'], ['Enter'])

    def test_down_never_accepted_never_enters(self):
        self.run_screens([TRUST_NO], ['Down'] * 3)

    def test_unknown_and_ambiguous_cursor_never_enters(self):
        for screen in (TRUST_YES.replace('\u276f', '>'),
                       TRUST_YES + '\n\u276f No, exit',
                       CHANNELS.replace('\u276f 1.', '1.') + '\n\u276f 2. Exit',
                       TRUST_YES.replace('Enter to confirm', '')):
            with self.subTest(screen=screen):
                self.run_screens([screen], [])

    def test_transient_selection_is_not_confirmation(self):
        self.run_screens([TRUST_YES, TRUST_NO, 'bypass permissions on'], ['Down'])

    def test_exited_session_is_not_reported_launched(self):
        self.run_screens([TRUST_NO], [], gone=True)


if __name__ == '__main__':
    unittest.main()
