import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('tg-approve.js').resolve()


class BypassPermissionsTests(unittest.TestCase):
    def invoke(self, event, tool, args):
        with tempfile.TemporaryDirectory() as home:
            workspace = Path(home) / 'project'
            workspace.mkdir()
            payload = dict(hook_event_name=event, permission_mode='bypassPermissions',
                           cwd=str(workspace), tool_name=tool, tool_input=args(workspace))
            env = {**os.environ, 'HOME': home, 'CLAUDE_PROJECT_DIR': str(workspace)}
            for key in ('CODEX_THREAD_ID', 'TG_BRIDGE_AGENT'):
                env.pop(key, None)
            result = subprocess.run(['node', str(SCRIPT)], input=json.dumps(payload),
                                    capture_output=True, text=True, env=env, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout) if result.stdout.strip() else None

    def test_native_request_for_local_edit_is_allowed(self):
        result = self.invoke('PermissionRequest', 'Edit', lambda p: {'file_path': str(p/'a.py')})
        self.assertEqual(result['hookSpecificOutput']['decision']['behavior'], 'allow')

    def test_native_request_for_local_commit_is_allowed(self):
        result = self.invoke('PermissionRequest', 'Bash', lambda p: {'command': 'git commit -m "local change"'})
        self.assertEqual(result['hookSpecificOutput']['decision']['behavior'], 'allow')

    def test_pretool_local_edit_still_allowed(self):
        result = self.invoke('PreToolUse', 'Write', lambda p: {'file_path': str(p/'a.py')})
        self.assertEqual(result['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_sensitive_native_requests_are_not_autoapproved(self):
        for tool, args in [
            ('Bash', lambda p: {'command': 'git push origin main'}),
            ('Bash', lambda p: {'command': './deploy-prod.sh'}),
            ('Edit', lambda p: {'file_path': str(p.parent/'outside.txt')}),
        ]:
            with self.subTest(tool=tool):
                result = self.invoke('PermissionRequest', tool, args)
                self.assertTrue(result is None or result.get('hookSpecificOutput', {}).get('decision', {}).get('behavior') != 'allow')


if __name__ == '__main__':
    unittest.main()
