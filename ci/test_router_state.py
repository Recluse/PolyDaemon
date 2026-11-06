import json
import sqlite3
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from router_state import snapshot, verify
from bot.activation import router_guard
import yaml


class SnapshotTests(unittest.TestCase):
    def test_ci_activation_is_fail_closed_even_when_both_files_are_missing(self):
        repo = Path(__file__).resolve().parents[1]
        steps = yaml.safe_load((repo / '.gitlab-ci.yml').read_text())['deploy']['script']
        self.assertTrue(steps[3].startswith('docker build'))
        with tempfile.TemporaryDirectory(dir=repo / 'tmp') as tmp:
            home = Path(tmp)
            config = home / 'bot-api'
            config.mkdir()
            def allowed():
                return subprocess.run(['bash', '-e', '-c', '\n'.join(steps[:3])],
                                      env={**os.environ, 'HOME': tmp}, capture_output=True).returncode == 0
            self.assertFalse(allowed())
            (config / 'polydaemon-node-id').write_text('old\n')
            self.assertFalse(allowed())
            (config / 'polydaemon-active-node').write_text('new\n')
            self.assertFalse(allowed())
            (config / 'polydaemon-active-node').write_text('old\n')
            self.assertTrue(allowed())

    def test_ci_rechecks_the_permit_immediately_before_compose_up(self):
        repo = Path(__file__).resolve().parents[1]
        steps = yaml.safe_load((repo / '.gitlab-ci.yml').read_text())['deploy']['script']
        up = next(i for i, step in enumerate(steps) if 'compose' in step and ' up ' in step + ' ')
        guard = steps[up - 1]
        self.assertNotIn('docker', guard)
        (repo / 'tmp').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=repo / 'tmp') as tmp:
            config = Path(tmp) / 'bot-api'
            config.mkdir()

            def allowed():
                return subprocess.run(['bash', '-e', '-c', guard], env={**os.environ, 'HOME': tmp},
                                      capture_output=True).returncode == 0
            self.assertFalse(allowed())
            (config / 'polydaemon-node-id').write_text('a\n')
            (config / 'polydaemon-active-node').write_text('a\n')
            self.assertTrue(allowed())
            (config / 'polydaemon-active-node').write_text('maintenance\n')  # denied during build
            self.assertFalse(allowed())
            (config / 'polydaemon-active-node').unlink()
            self.assertFalse(allowed())

    def test_wal_backup_sidecars_checksums_and_no_overwrite(self):
        scratch = Path(__file__).resolve().parents[1] / 'tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            root = Path(tmp)
            source = root / 'state'
            source.mkdir()
            db = sqlite3.connect(source / 'bot.db')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE fixture(value TEXT)')
            db.execute("INSERT INTO fixture VALUES ('durable')")
            db.commit()
            (source / 'permission-overrides.json').write_text('{}')
            try:
                with router_guard(source, None, None):
                    with self.assertRaises(OSError):
                        snapshot(source, root / 'blocked')
                result = snapshot(source, root / 'backup')
                self.assertEqual(set(result['files']), {'bot.db', 'permission-overrides.json'})
                self.assertEqual(verify(root / 'backup'), result)
                with sqlite3.connect(root / 'backup/bot.db') as copy:
                    self.assertEqual(copy.execute('SELECT value FROM fixture').fetchone(), ('durable',))
                with self.assertRaises(FileExistsError):
                    snapshot(source, root / 'backup')
                (root / 'backup/permission-overrides.json').write_text('{"changed":true}')
                with self.assertRaises(ValueError):
                    verify(root / 'backup')
                (source / 'default-instance.json').symlink_to(source / 'permission-overrides.json')
                with self.assertRaises(ValueError):
                    snapshot(source, root / 'symlink')
            finally:
                db.close()


if __name__ == '__main__':
    unittest.main()
