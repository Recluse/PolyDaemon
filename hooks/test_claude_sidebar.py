import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sidebar_installer", Path(__file__).with_name("claude_sidebar.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
SCRATCH = Path(__file__).resolve().parent.parent / 'tmp'
SCRATCH.mkdir(exist_ok=True)


class SidebarBundle(unittest.TestCase):
    def test_bundle_owns_only_its_directory_and_copies_canonical_assets(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as tmp:
            root = Path(tmp)
            repo = root / 'repo'
            plugin = repo / 'claude-mods/pd-sidebar'
            manifest = plugin / '.claude-plugin/plugin.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"name":"pd-sidebar"}')
            for rel in ('clients/claude-status.cjs', 'hooks/tg-bridge-locate.js'):
                f = repo / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text('fixture ' + rel)
            target = root / 'bundle'
            installer.build_bundle(repo, target)
            for rel in ('clients/claude-status.cjs', 'hooks/tg-bridge-locate.js'):
                self.assertEqual((target / 'pd-sidebar/assets' / rel).read_bytes(), (repo / rel).read_bytes())
            catalog = json.loads((target / '.claude-plugin/marketplace.json').read_text())
            self.assertEqual(catalog['plugins'][0]['source'], './pd-sidebar')
            installer.build_bundle(repo, target)
            self.assertEqual(len(list(root.glob('bundle.bak-*'))), 1)
            before = (target / 'pd-sidebar/.claude-plugin/plugin.json').read_bytes()
            def reject(plugin):
                self.assertTrue((plugin / 'assets/clients/claude-status.cjs').is_file())
                raise ValueError('Invalid mod')
            with self.assertRaisesRegex(ValueError, 'Invalid mod'):
                installer.build_bundle(repo, target, reject)
            self.assertEqual((target / 'pd-sidebar/.claude-plugin/plugin.json').read_bytes(), before)
            self.assertEqual(len(list(root.glob('bundle.bak-*'))), 1)
            self.assertEqual(list(root.glob('.sidebar-build-*')), [])
            (target / '.polydaemon-sidebar-bundle').unlink()
            with self.assertRaises(ValueError):
                installer.build_bundle(repo, target)
            self.assertTrue(target.exists())

    def test_dry_run_never_builds_or_calls_cli(self):
        with patch.object(installer, 'build_bundle') as build, patch.object(installer.subprocess, 'run') as run:
            self.assertEqual(installer.main(Path('/unused'), ['--sidebar', '--dry-run']), 0)
            build.assert_not_called()
            run.assert_not_called()
            self.assertEqual(installer.main(Path('/unused'), ['--sidebar', '--mcp']), 2)


if __name__ == '__main__':
    unittest.main()
