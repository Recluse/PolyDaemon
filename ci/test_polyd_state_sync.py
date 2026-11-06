#!/usr/bin/env python3
"""Tests for state-sync restore semantics (push needs a remote, so it is not covered)."""
from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyd_state_sync as sync  # noqa: E402
from router_online_backup import capture  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tg-bot'))


def make_state(root: Path) -> Path:
    import sqlite3
    state = root / 'state'
    state.mkdir()
    for name in ('bot.db', 'updates.db'):
        db = sqlite3.connect(state / name)
        db.execute('CREATE TABLE t (x)')
        db.execute('INSERT INTO t VALUES (1)')
        db.commit()
        db.close()
    (state / 'topic-bindings.json').write_text('{}')
    return state


def evidence(root: Path, age_s: float = 0) -> Path:
    path = root / f'evidence-{age_s}.json'
    path.write_text(json.dumps({'fenced_node': 'old', 'method': 'stopped+close',
                                'verified_by': 'operator', 'verified_at': time.time() - age_s}))
    return path


class StateSync(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_restore_adopts_newest_snapshot(self) -> None:
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'restored'
        manifest = sync.restore(snaps, target)
        self.assertIn('bot.db', manifest['files'])
        self.assertTrue((target / 'bot.db').is_file())
        self.assertTrue((target / 'topic-bindings.json').is_file())
        self.assertEqual((target / 'topic-bindings.json').read_text(), '{}')

    def test_restore_refuses_a_populated_target_without_force(self) -> None:
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'restored'
        target.mkdir()
        (target / 'bot.db').write_text('existing')
        with self.assertRaises(ValueError):
            sync.restore(snaps, target)
        sync.restore(snaps, target, force=True, fencing_evidence=evidence(self.root))
        self.assertNotEqual((target / 'bot.db').read_bytes(), b'existing')

    def test_force_restore_over_live_state_requires_fresh_fencing_evidence(self) -> None:
        # Regression: --force used to overwrite a populated state directory
        # unconditionally, e.g. from an automatic pre-start step.
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'live'
        target.mkdir()
        (target / 'bot.db').write_bytes(b'newer live state')
        with self.assertRaises(PermissionError):
            sync.restore(snaps, target, force=True)  # the old automatic pre-start call
        self.assertEqual((target / 'bot.db').read_bytes(), b'newer live state')
        for proof in (self.root / 'missing.json', evidence(self.root, age_s=7200)):
            with self.assertRaises(PermissionError):
                sync.restore(snaps, target, force=True, fencing_evidence=proof)
            self.assertEqual((target / 'bot.db').read_bytes(), b'newer live state')
        sync.restore(snaps, target, force=True, fencing_evidence=evidence(self.root))
        self.assertNotEqual((target / 'bot.db').read_bytes(), b'newer live state')

    def test_cli_force_restore_reads_evidence_from_controller_env(self) -> None:
        import os
        import subprocess
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'live'
        target.mkdir()
        (target / 'bot.db').write_bytes(b'live')
        cmd = [sys.executable, str(Path(sync.__file__)), 'restore', str(snaps), str(target), '--force']
        env = {k: v for k, v in os.environ.items() if k != 'POLYD_FENCING_EVIDENCE'}
        self.assertNotEqual(subprocess.run(cmd, env=env, capture_output=True).returncode, 0)
        self.assertEqual((target / 'bot.db').read_bytes(), b'live')
        env['POLYD_FENCING_EVIDENCE'] = str(evidence(self.root))
        self.assertEqual(subprocess.run(cmd, env=env, capture_output=True).returncode, 0)
        self.assertNotEqual((target / 'bot.db').read_bytes(), b'live')

    def test_restore_refuses_while_the_router_holds_its_lock(self) -> None:
        import fcntl
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'live'
        target.mkdir()
        (target / 'bot.db').write_bytes(b'open by a running router')
        (target / 'bot.db-wal').write_bytes(b'live wal')
        with (target / 'router.lock').open('a+b') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)  # what router_guard holds
            with self.assertRaises(PermissionError):
                sync.restore(snaps, target, force=True, fencing_evidence=evidence(self.root))
        self.assertEqual((target / 'bot.db').read_bytes(), b'open by a running router')
        self.assertEqual((target / 'bot.db-wal').read_bytes(), b'live wal')

    def test_restore_refuses_while_a_router_answers_health(self) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                self.send_response(401)
                self.end_headers()

        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            state = make_state(self.root)
            snaps = self.root / 'snaps'
            snaps.mkdir()
            capture(state, snaps / '20260101-000000')
            target = self.root / 'live'
            target.mkdir()
            (target / 'bot.db').write_bytes(b'live')
            url = f'http://127.0.0.1:{httpd.server_address[1]}/'
            with self.assertRaises(PermissionError):
                sync.restore(snaps, target, force=True, fencing_evidence=evidence(self.root),
                             health_url=url)
            self.assertEqual((target / 'bot.db').read_bytes(), b'live')
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_restore_requires_a_verified_snapshot(self) -> None:
        snaps = self.root / 'snaps'
        snaps.mkdir()
        broken = snaps / '20260101-000000'
        broken.mkdir()
        (broken / 'manifest.json').write_text('{}')
        with self.assertRaises(ValueError):
            sync.restore(snaps, self.root / 'target')

    def test_newest_snapshot_is_picked(self) -> None:
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        capture(state, snaps / '20260101-010000')
        newest = sync.newest_snapshot(snaps)
        self.assertIsNotNone(newest)
        assert newest is not None
        self.assertEqual(newest.name, '20260101-010000')

    def test_restore_without_snapshots_fails(self) -> None:
        with self.assertRaises(FileNotFoundError):
            sync.restore(self.root / 'empty', self.root / 'target')

    def test_restore_drops_stale_sqlite_sidecars(self) -> None:
        state = make_state(self.root)
        snaps = self.root / 'snaps'
        snaps.mkdir()
        capture(state, snaps / '20260101-000000')
        target = self.root / 'restored'
        target.mkdir()
        (target / 'bot.db-wal').write_bytes(b'stale journal')
        (target / 'bot.db-shm').write_bytes(b'stale shm')
        sync.restore(snaps, target, force=True, fencing_evidence=evidence(self.root))
        self.assertFalse((target / 'bot.db-wal').exists())
        self.assertFalse((target / 'bot.db-shm').exists())
        self.assertTrue((target / 'bot.db').is_file())


if __name__ == '__main__':
    unittest.main()
