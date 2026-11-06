"""Activation permit wiring in the router entrypoint."""
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import tgbridge
from bot.activation import check_permit

HA_ENV = ('POLYDAEMON_NODE_ID', 'POLYDAEMON_ACTIVATION_FILE', 'POLYDAEMON_NODE_ROLE')


class EntrypointPermit(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / 'tmp'
        root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temp.name)
        self.permit = self.root / 'active-node'

    def tearDown(self):
        self.temp.cleanup()

    def run_main(self, build=None, **env):
        clean = {k: v for k, v in os.environ.items() if k not in HA_ENV}
        app = Mock()
        build = build or Mock(return_value=app)
        with patch.dict(os.environ, {**clean, **env}, clear=True), \
                patch.object(tgbridge, 'DB_PATH', self.root / 'state' / 'bot.db'), \
                patch.object(tgbridge, 'load_config', return_value={}), \
                patch.object(tgbridge, 'build_application', build):
            tgbridge.main()
        return build, app

    def test_standalone_without_ha_env_still_starts(self):
        build, app = self.run_main()
        build.assert_called_once()
        app.run_polling.assert_called_once()

    def test_declared_role_without_permit_refuses_before_build(self):
        # Regression: a reserve whose node id/permit env was lost used to start
        # as "standalone" and poll.
        for role in ('reserve', 'primary'):
            build = Mock()
            with self.assertRaises(RuntimeError):
                self.run_main(build, POLYDAEMON_NODE_ROLE=role)
            build.assert_not_called()

    def test_empty_role_variable_is_not_standalone(self):
        # A compose substitution that came out empty must not turn an HA node
        # into a standalone poller.
        with self.assertRaises(RuntimeError):
            check_permit(None, None, '')
        build = Mock()
        with self.assertRaises(RuntimeError):
            self.run_main(build, POLYDAEMON_NODE_ROLE='')
        build.assert_not_called()

    def test_unknown_role_refuses(self):
        with self.assertRaises(RuntimeError):
            check_permit(None, None, 'standby')

    def test_declared_role_with_matching_permit_starts(self):
        self.permit.write_text('node-a\n')
        build, app = self.run_main(POLYDAEMON_NODE_ROLE='reserve', POLYDAEMON_NODE_ID='node-a',
                                   POLYDAEMON_ACTIVATION_FILE=str(self.permit))
        app.run_polling.assert_called_once()

    def test_declared_role_with_denied_permit_refuses(self):
        self.permit.write_text('maintenance\n')
        with self.assertRaises(RuntimeError):
            self.run_main(POLYDAEMON_NODE_ROLE='reserve', POLYDAEMON_NODE_ID='node-a',
                          POLYDAEMON_ACTIVATION_FILE=str(self.permit))


class PermitRecheck(unittest.TestCase):
    """A running HA router must notice a withdrawn permit before replay and while polling."""

    def setUp(self):
        root = Path(__file__).resolve().parents[1] / 'tmp'
        root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.root = Path(self.temp.name)
        self.permit = self.root / 'active-node'
        self.permit.write_text('node-a\n')
        self.env = dict(POLYDAEMON_NODE_ROLE='reserve', POLYDAEMON_NODE_ID='node-a',
                        POLYDAEMON_ACTIVATION_FILE=str(self.permit))

    def tearDown(self):
        self.temp.cleanup()

    def main_build_call(self):
        build = Mock()
        clean = {k: v for k, v in os.environ.items() if k not in HA_ENV}
        with patch.dict(os.environ, {**clean, **self.env}, clear=True), \
                patch.object(tgbridge, 'DB_PATH', self.root / 'state' / 'bot.db'), \
                patch.object(tgbridge, 'load_config', return_value={}), \
                patch.object(tgbridge, 'build_application', build):
            tgbridge.main()
        return build.call_args

    def test_entrypoint_wires_recheck_and_watch_in_ha_mode(self):
        call = self.main_build_call()
        check, job = call.kwargs.get('permit_check'), call.kwargs.get('permit_job')
        self.assertIsNotNone(check)
        self.assertIsNotNone(job)
        check()  # permit still granted
        context = Mock()
        asyncio.run(job(context))
        context.application.stop_running.assert_not_called()
        self.permit.write_text('maintenance\n')  # controller demote
        with self.assertRaises(RuntimeError):
            check()
        asyncio.run(job(context))
        context.application.stop_running.assert_called_once()
        self.permit.unlink()  # permit file vanished
        context = Mock()
        asyncio.run(job(context))
        context.application.stop_running.assert_called_once()

    def test_undecodable_permit_is_a_deny_and_stops_polling(self):
        call = self.main_build_call()
        check, job = call.kwargs['permit_check'], call.kwargs['permit_job']
        self.permit.write_bytes(b'\xff\xfe\x00garbage')
        with self.assertRaises(RuntimeError):
            check()
        context = Mock()
        asyncio.run(job(context))
        context.application.stop_running.assert_called_once()

    def test_post_init_rechecks_before_replaying_pending_updates(self):
        config = {'telegram': {'bot_token': '123:fixture', 'allowed_users': [1]}, 'bot': {}}
        check = Mock(side_effect=RuntimeError('withdrawn'))
        with patch.object(tgbridge, 'DB_PATH', self.root / 'state' / 'bot.db'):
            app = tgbridge.build_application(config, permit_check=check, permit_job=Mock())
        restore = Mock()
        app.update_queue.restore = restore
        with self.assertRaises(RuntimeError):
            asyncio.run(app.post_init(app))
        check.assert_called_once()
        restore.assert_not_called()
        app.update_queue.journal.close()


if __name__ == '__main__':
    unittest.main()
