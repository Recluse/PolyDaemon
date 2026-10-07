"""Agent-specific installation checks; no real user configuration is changed."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import mcp_entry as m


class InstallTest(unittest.TestCase):
    def test_independent_agents_and_loader_ownership(self):
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            machine = home / ".config/polydaemon/machine.env"
            machine.parent.mkdir(parents=True)
            machine.write_text("TG_BOT_TOKEN=fixture\nTG_BRIDGE_AUTH_TOKEN=fixture\n")
            config = home / ".config/opencode/opencode.json"
            config.parent.mkdir(parents=True)
            config.write_text('{"provider":{"keep":true}}')
            with patch.object(m, "MACHINE_ENV", machine), patch.object(m.pathlib.Path, "home", return_value=home), \
                 patch.object(m.shutil, "which", side_effect=lambda name: name if name == "codex" else None), \
                 patch.object(m.subprocess, "run") as run:
                run.return_value.returncode = 0
                self.assertEqual(m.main(repo, False, codex=True), 0)
                self.assertTrue(all(call.args[0][0] == "codex" for call in run.call_args_list))
                run.reset_mock()
                self.assertEqual(m.uninstall(True, dry=True), 0)
                run.assert_not_called()
                self.assertEqual(m.uninstall(True), 0)
                self.assertEqual(run.call_args.args[0][0], "codex")
                run.reset_mock()
                self.assertEqual(m.main(repo, True, opencode=True), 0)
                loader = config.parent / "plugins/tg-bridge/index.ts"
                self.assertFalse(loader.exists())
                self.assertEqual(m.opencode_loader(repo, False), 0)
                first = loader.read_text()
                self.assertIn(json.dumps((repo / "clients/opencode-plugin.ts").as_uri()), first)
                tui = loader.with_name("tui.tsx")
                manifest = loader.with_name("package.json")
                self.assertIn(json.dumps((repo / "clients/opencode-tui.tsx").as_uri()), tui.read_text())
                self.assertEqual(json.loads(manifest.read_text())["exports"]["./tui"], "./tui.tsx")
                self.assertEqual(m.opencode_loader(repo, False), 0)
                self.assertEqual(loader.read_text(), first)
                self.assertEqual(machine.with_name("repo-path").read_text(), str(repo) + "\n")
                self.assertEqual(config.read_text(), '{"provider":{"keep":true}}')
                loader.write_text("export default { id: 'foreign' };\n")
                self.assertEqual(m.opencode_loader(repo, False), 1)
                self.assertEqual(m.opencode_loader(repo, False, remove=True), 1)
                self.assertIn("foreign", loader.read_text())
                loader.write_text(first)
                old_tui = tui.read_text()
                tui.write_text("foreign TUI")
                self.assertEqual(m.opencode_loader(repo, False), 1)
                self.assertEqual(loader.read_text(), first)
                self.assertEqual(m.opencode_loader(repo, False, remove=True), 1)
                tui.write_text(old_tui)
                old_manifest = manifest.read_text()
                manifest.write_text('{"name":"foreign"}')
                self.assertEqual(m.opencode_loader(repo, False), 1)
                self.assertEqual(m.opencode_loader(repo, False, remove=True), 1)
                manifest.write_text(old_manifest)
                self.assertEqual(m.uninstall(False, opencode=True, repo=repo), 0)
                self.assertFalse(loader.exists())
                self.assertFalse(tui.exists())
                self.assertFalse(manifest.exists())
                self.assertFalse(machine.with_name("repo-path").exists())
                self.assertEqual(config.read_text(), '{"provider":{"keep":true}}')
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
