import os
from pathlib import Path
import tempfile
import unittest

from botapi_attachment_ssh import attachment_parts, open_regular


class AttachmentReader(unittest.TestCase):
    def test_exact_command_and_scope(self):
        config = {"container": "polyd-bot-api", "bot_directory": "123:fixture"}
        prefix = "docker exec polyd-bot-api cat "
        root = "/var/lib/telegram-bot-api/123:fixture/"
        self.assertEqual(attachment_parts(prefix + repr(root + "documents/a b.txt"), config),
                         ["documents", "a b.txt"])
        for command in ["id", "", "bash", prefix + root + "documents/../secret",
                        prefix + root + "db.sqlite", prefix + root + "documents//a",
                        prefix + root + "documents/a; id", prefix + root + "../other/photos/a",
                        prefix + root.replace("123:fixture", "other") + "photos/a",
                        "docker exec other cat " + root + "photos/a"]:
            with self.subTest(command=command), self.assertRaises(ValueError):
                attachment_parts(command, config)

    def test_regular_only_and_no_symlinks(self):
        parent = Path(__file__).resolve().parents[1] / "tmp"
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as tmp:
            root = Path(tmp).resolve()
            (root / "documents").mkdir()
            (root / "documents/a").write_bytes(b"attachment\x00bytes")
            with os.fdopen(open_regular(str(root), ["documents", "a"]), "rb") as source:
                self.assertEqual(source.read(), b"attachment\x00bytes")
            (root / "documents/link").symlink_to(root / "documents/a")
            (root / "linked").symlink_to(root / "documents", target_is_directory=True)
            os.mkfifo(root / "documents/fifo")
            for parts in (["documents", "link"], ["linked", "a"], ["documents", "fifo"]):
                with self.subTest(parts=parts), self.assertRaises((OSError, ValueError)):
                    open_regular(str(root), parts)


if __name__ == "__main__":
    unittest.main()
