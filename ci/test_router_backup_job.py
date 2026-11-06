import fcntl
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from router_backup_job import initialize, run_job
from test_router_online_backup import OnlineBackupTests


class BackupJobTests(OnlineBackupTests):
    def test_job_retains_only_own_accepted_backups(self):
        root = self.root / 'managed'
        initialize(root)
        unrelated = root / 'quiesced-checkpoint'
        unrelated.mkdir()
        first = run_job(self.source, root, keep=1)
        second = run_job(self.source, root, keep=1)
        self.assertFalse((root / first['directory']).exists())
        self.assertTrue((root / second['directory'] / 'job-receipt.json').exists())
        self.assertTrue(unrelated.exists())

    def test_failed_capture_preserves_last_good_and_lock_rejects_overlap(self):
        root = self.root / 'managed'
        initialize(root)
        good = run_job(self.source, root)
        with patch('router_backup_job.subprocess.run', side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                run_job(self.source, root)
        self.assertTrue((root / good['directory']).exists())
        with (root / '.job.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                run_job(self.source, root)

    def test_capacity_guard_fails_before_capture_and_preserves_residues(self):
        root = self.root / 'managed'
        initialize(root)
        residue = root / '.router-backup-abandoned'
        residue.mkdir()
        with patch('router_backup_job.shutil.disk_usage', return_value=SimpleNamespace(free=0)):
            with patch('router_backup_job.subprocess.run') as process:
                with self.assertRaisesRegex(ValueError, 'free space'):
                    run_job(self.source, root)
                process.assert_not_called()
        self.assertTrue(residue.exists())
        with patch('router_backup_job.ROOT_CAP', 1):
            with self.assertRaisesRegex(ValueError, 'capacity'):
                run_job(self.source, root)


if __name__ == '__main__':
    unittest.main()
