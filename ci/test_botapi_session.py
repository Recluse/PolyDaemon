import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

from botapi_session import restore, validate


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        for name, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o777
            member.linkname = '/outside'
            body = b'fixture\x00bytes' if kind == tarfile.REGTYPE else b''
            member.size = len(body)
            tar.addfile(member, io.BytesIO(body))
    stream.seek(0)
    return stream


class SessionTests(unittest.TestCase):
    def test_rejects_foreign_traversal_links_devices_and_duplicates(self):
        cases = [
            [('other/data', tarfile.REGTYPE)],
            [('/bot/data', tarfile.REGTYPE)],
            [('bot/../data', tarfile.REGTYPE)],
            [('bot/./data', tarfile.REGTYPE)],
            [('bot//data', tarfile.REGTYPE)],
            [('bot/data', tarfile.SYMTYPE)],
            [('bot/data', tarfile.LNKTYPE)],
            [('bot/data', tarfile.FIFOTYPE)],
            [('bot/data', tarfile.CHRTYPE)],
            [('bot', tarfile.REGTYPE)],
            [('bot/data', tarfile.REGTYPE), ('bot/data', tarfile.REGTYPE)],
            [],
        ]
        for entries in cases:
            with self.subTest(entries=entries), tarfile.open(fileobj=archive(entries)) as tar:
                with self.assertRaises(ValueError):
                    validate(tar, 'bot')

    def test_restore_preserves_bytes_and_restricts_permissions(self):
        base = Path(__file__).resolve().parents[1] / 'tmp'
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base, prefix='session-test-') as temp:
            root = Path(temp)
            volume = root / 'volume'
            volume.mkdir()
            source = root / 'session.tar'
            source.write_bytes(archive([('bot/', tarfile.DIRTYPE), ('bot/photos/x', tarfile.REGTYPE)]).read())
            result = restore(source, volume, 'bot', os.getuid(), os.getgid())
            self.assertEqual(result, {'files': 1, 'bytes': 13})
            output = volume / 'bot/photos/x'
            self.assertEqual(output.read_bytes(), b'fixture\x00bytes')
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.parent.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(ValueError):
                restore(source, volume, 'bot', os.getuid(), os.getgid())

    def test_invalid_archive_writes_nothing(self):
        base = Path(__file__).resolve().parents[1] / 'tmp'
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base, prefix='session-test-') as temp:
            root = Path(temp)
            source = root / 'session.tar'
            source.write_bytes(archive([('bot/good', tarfile.REGTYPE), ('other/bad', tarfile.REGTYPE)]).read())
            with self.assertRaises(ValueError):
                restore(source, root, 'bot', os.getuid(), os.getgid())
            self.assertFalse((root / 'bot').exists())
            self.assertFalse((root / 'other').exists())


if __name__ == '__main__':
    unittest.main()
