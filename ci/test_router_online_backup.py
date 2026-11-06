import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from router_online_backup import capture, stable_json, verify


class OnlineBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'state'
        self.source.mkdir()
        self.connections = []
        for name in ('bot.db', 'updates.db'):
            db = sqlite3.connect(self.source / name)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE fixture(value TEXT)')
            db.execute("INSERT INTO fixture VALUES ('committed')")
            db.commit()
            self.connections.append(db)
        (self.source / 'topic-bindings.json').write_text('{}')

    def tearDown(self):
        for db in self.connections:
            db.close()
        self.temp.cleanup()

    def test_online_wal_copy_and_isolated_verification(self):
        target = self.root / 'backup'
        result = capture(self.source, target)
        self.assertFalse(result['cross_file_atomic'])
        self.assertFalse(result['automatic_restore_allowed'])
        self.assertEqual(verify(target), result)
        for name in ('bot.db', 'updates.db'):
            with sqlite3.connect(target / name) as db:
                self.assertEqual(db.execute('SELECT value FROM fixture').fetchone(), ('committed',))
            self.assertEqual((target / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(ValueError):
            capture(self.source, target)

    def test_failure_does_not_publish_or_remove_existing_backup(self):
        target = self.root / 'backup'
        with self.assertRaises(TimeoutError):
            capture(self.source, target, timeout=0)
        self.assertFalse(target.exists())
        self.assertEqual(list(self.root.glob('.router-backup-*')), [])
        (self.source / 'topic-bindings.json').write_text('not json')
        with self.assertRaises(ValueError):
            capture(self.source, target)
        self.assertFalse(target.exists())

    def test_symlink_tamper_and_restore_contract_rejected(self):
        target = self.root / 'backup'
        capture(self.source, target)
        manifest_path = target / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['automatic_restore_allowed'] = True
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            verify(target)
        sidecar = self.source / 'topic-bindings.json'
        sidecar.unlink()
        sidecar.symlink_to(target / 'topic-bindings.json')
        with self.assertRaises(OSError):
            stable_json(sidecar)
        with self.assertRaises(ValueError):
            capture(self.source, self.root / 'other')

    def test_fifo_without_writer_does_not_block(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        result = subprocess.run(
            [sys.executable, '-c',
             'from pathlib import Path; from router_online_backup import stable_json; '
             'stable_json(Path(__import__("sys").argv[1]))', str(fifo)],
            cwd=Path(__file__).parent, capture_output=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Invalid sidecar', result.stderr)


if __name__ == '__main__':
    unittest.main()
