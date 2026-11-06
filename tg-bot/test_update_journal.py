import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from telegram import Update
from telegram.ext import Application, TypeHandler

from bot.activation import check_permit, router_guard
from bot.update_journal import DurableUpdateQueue, JournalApplication, UpdateJournal
from test_topic_activity import FakeTelegram


class JournalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / 'tmp'
        root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.path = Path(self.temp.name) / 'updates.db'
        self.journal = UpdateJournal(self.path)
        self.queue = DurableUpdateQueue(self.journal)

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def update(self, n):
        return Update.de_json({'update_id': n, 'message': {
            'message_id': n, 'date': 1, 'text': 'fixture',
            'chat': {'id': 123, 'type': 'private'}}}, None)

    def state(self, n):
        return self.journal.db.execute('SELECT state,payload FROM telegram_updates WHERE update_id=?', (n,)).fetchone()

    async def test_receipt_is_durable_before_put_returns_and_deduplicates(self):
        await self.queue.put(self.update(1))
        other = UpdateJournal(self.path)
        try:
            self.assertEqual([u.update_id for u in other.recover(None)], [1])
        finally:
            other.close()
        await self.queue.put(self.update(1))
        self.assertEqual(self.queue.qsize(), 1)

    async def test_pending_replays_but_interrupted_side_effect_does_not(self):
        for n in (1, 2, 3):
            await self.queue.put(self.update(n))
        self.assertTrue(self.journal.claim(2))
        self.assertTrue(self.journal.claim(3))
        self.journal.finish(3)
        restored = DurableUpdateQueue(self.journal)
        await restored.restore(None)
        self.assertEqual(restored.qsize(), 1)
        self.assertEqual((await restored.get()).update_id, 1)
        self.assertEqual(self.state(2)[0], 'uncertain')
        self.assertEqual(self.state(3), ('done', None))
        await restored.put(self.update(3))
        self.assertTrue(restored.empty())

    async def test_storage_failure_stops_without_queueing_or_ack(self):
        self.queue.on_failure = Mock()
        with patch.object(self.journal, 'receive', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await self.queue.put(self.update(1))
        self.queue.on_failure.assert_called_once()
        self.assertTrue(self.queue.empty())

    async def test_native_handlers_success_error_and_cancel(self):
        handler = AsyncMock()
        app = (Application.builder().application_class(JournalApplication)
               .token('123:fixture').request(FakeTelegram()).update_queue(self.queue).build())
        app.add_handler(TypeHandler(Update, handler))
        app.add_error_handler(AsyncMock())
        async with app:
            await self.queue.put(self.update(1))
            await app.process_update(await self.queue.get())
            self.queue.task_done()
            self.assertEqual(self.state(1), ('done', None))
            handler.side_effect = ValueError('fixture')
            await self.queue.put(self.update(2))
            await app.process_update(await self.queue.get())
            self.queue.task_done()
            self.assertEqual(self.state(2)[0], 'uncertain')
            handler.side_effect = asyncio.CancelledError()
            await self.queue.put(self.update(3))
            with self.assertRaises(asyncio.CancelledError):
                await app.process_update(await self.queue.get())
            self.queue.task_done()
            self.assertEqual(self.state(3)[0], 'uncertain')

    async def test_native_updater_persists_before_advancing_offset(self):
        journal = self.journal
        seen = asyncio.Event()
        offsets = []

        class PollAPI(FakeTelegram):
            async def do_request(self, url, method, request_data=None, **kwargs):
                name = url.rsplit('/', 1)[-1]
                if name == 'deleteWebhook':
                    return 200, b'{"ok":true,"result":true}'
                if name != 'getUpdates':
                    return await super().do_request(url, method, request_data, **kwargs)
                offset = request_data.parameters.get('offset', 0)
                offsets.append(offset)
                if offset == 11:
                    assert journal.db.execute('SELECT state FROM telegram_updates WHERE update_id=10').fetchone()
                    seen.set()
                    await asyncio.sleep(0.01)
                    result = []
                else:
                    result = [{'update_id': 10}]
                return 200, json.dumps({'ok': True, 'result': result}).encode()

        api = PollAPI()
        app = (Application.builder().token('123:fixture').request(api)
               .get_updates_request(api).update_queue(self.queue).build())
        async with app:
            await app.updater.start_polling(drop_pending_updates=False)
            await asyncio.wait_for(seen.wait(), 2)
            await app.updater.stop()
        self.assertEqual(offsets[0], 0)
        self.assertIn(11, offsets)

    def test_standby_and_same_state_duplicate_refuse_start(self):
        root = Path(self.temp.name)
        permit = root / 'active-node'
        with self.assertRaises(RuntimeError):
            check_permit('a', str(permit))
        permit.write_text('a\n')
        with self.assertRaises(RuntimeError):
            check_permit('b', str(permit))
        with self.assertRaises(RuntimeError):
            check_permit('a', None)
        with router_guard(root, 'a', str(permit)):
            with self.assertRaises(OSError):
                with router_guard(root, 'a', str(permit)):
                    self.fail('duplicate router started')
        with router_guard(root, 'a', str(permit)):
            pass


if __name__ == '__main__':
    unittest.main()
