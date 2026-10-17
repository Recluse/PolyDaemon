import asyncio
import json
import unittest
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from telegram import ForceReply, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ExtBot
from telegram.request import BaseRequest

from bot.topic_activity import TopicActivity, TopicMessageObserver, incoming_topic_message, valid_event
from bridge.registry import RuntimeInstance
import httpx
from bot.storage import Storage
from bot.http_registry import make_registry_server


class FakeTelegram(BaseRequest):
    def __init__(self):
        self.serial = 10
    @property
    def read_timeout(self):
        return 5
    async def initialize(self):
        pass
    async def shutdown(self):
        pass
    async def do_request(self, url, method, request_data=None, **kwargs):
        name = url.rsplit('/', 1)[-1]
        data = request_data.parameters if request_data else {}
        self.serial += 1
        result = ({'id': 123, 'is_bot': True, 'first_name': 'Fixture', 'username': 'fixture_bot'} if name == 'getMe' else
                  {'message_id': self.serial, 'chat': {'id': -100123, 'type': 'supergroup'}, 'date': 1,
                   'text': data.get('text', ''), 'message_thread_id': data.get('message_thread_id', 42)})
        return 200, json.dumps({'ok': True, 'result': result}).encode()


class TopicActivityTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_ptb_observer_excludes_cards_and_edits(self):
        activity = SimpleNamespace(note=Mock(), close=AsyncMock())
        async with ExtBot('123:fixture', request=FakeTelegram(), rate_limiter=TopicMessageObserver(activity)) as bot:
            for n in range(5):
                await bot.send_message(-100123, 'Request', message_thread_id=42, reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton('Allow', callback_data=f'approve:{n}:once')]]))
            await bot.edit_message_text('Changed', chat_id=-100123, message_id=11)
            await bot.send_message(-100123, 'Custom reply request', message_thread_id=42, reply_markup=ForceReply())
            await bot.send_message(-100123, 'Compaction sent', message_thread_id=42,
                                   rate_limit_args={'topic_activity': False})
            self.assertEqual(activity.note.call_count, 0)
            await bot.send_message(-100123, 'Normal', message_thread_id=42)
            self.assertEqual(activity.note.call_count, 1)
            self.assertEqual(activity.note.call_args.args[0]['message_thread_id'], 42)
            await bot.send_photo(-100123, 'fixture-photo-id', message_thread_id=42)
            self.assertEqual(activity.note.call_count, 2)

    async def test_scope_duplicates_siblings_and_no_registry_mutation(self):
        targets = [RuntimeInstance('w', 'w', 'w', '127.0.0.1', p, 'fixture', '/work/own') for p in (3100, 3101)]
        targets.append(RuntimeInstance('x', 'x', 'x', '127.0.0.1', 3102, 'fixture', '/work/other'))
        storage = SimpleNamespace(get_topic=Mock(side_effect=lambda cwd: (-100123, 42 if cwd == '/work/own' else 99)),
                                  record_compact_activity=Mock())
        client = SimpleNamespace(post_topic_activity=AsyncMock())
        activity = TopicActivity({}, storage, client)
        event = {'chat_id': -100123, 'message_thread_id': 42, 'message_id': 2}
        with patch('bot.topic_activity.load_runtime_instances', return_value=targets):
            activity.note(event); activity.note(event)
            await asyncio.gather(*activity.jobs)
        self.assertEqual([c.args[0].port for c in client.post_topic_activity.call_args_list], [3100, 3101])
        storage.record_compact_activity.assert_called_once_with(-100123, 42, 2)
        await activity.close()
        self.assertFalse(valid_event({**event, 'message_id': True}))
        self.assertFalse(valid_event({**event, 'message_thread_id': None}))

    async def test_real_storage_compaction_notice_and_prompts_do_not_rearm(self):
        scratch = Path(__file__).resolve().parent.parent / 'tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as home:
            storage = Storage(Path(home) / 'bot.db')
            activity = TopicActivity({}, storage, SimpleNamespace(post_topic_activity=AsyncMock()))
            try:
                with patch('bot.topic_activity.load_runtime_instances', return_value=[]), \
                     patch('bot.storage.time.time', return_value=10000) as clock:
                    async with ExtBot('123:fixture', request=FakeTelegram(), rate_limiter=TopicMessageObserver(activity)) as bot:
                        await bot.send_message(-100123, 'Normal', message_thread_id=42)
                        clock.return_value += 7200
                        self.assertTrue(storage.claim_compact_attempt(-100123, 42, 7200))
                        await bot.send_message(-100123, 'Compaction sent', message_thread_id=42,
                                               rate_limit_args={'topic_activity': False})
                        await bot.send_message(-100123, 'Request', message_thread_id=42, reply_markup=ForceReply())
                        clock.return_value += 86400
                        self.assertFalse(storage.compact_ready(-100123, 42, 7200))
                        await bot.send_message(-100123, 'New work', message_thread_id=42)
                        self.assertFalse(storage.compact_ready(-100123, 42, 7200))
                        clock.return_value += 7200
                        self.assertTrue(storage.claim_compact_attempt(-100123, 42, 7200))
            finally:
                await activity.close()
                storage.close()

    async def test_incoming_new_only_and_observation_failure_keeps_success(self):
        activity = SimpleNamespace(note=Mock())
        context = SimpleNamespace(application=SimpleNamespace(bot_data={'topic_activity': activity}))
        msg = {'message_id': 12, 'date': 1, 'chat': {'id': -100123, 'type': 'supergroup'}, 'message_thread_id': 42}
        for kind in ['edited_message', 'callback_query']:
            data = {'update_id': 1, kind: msg if kind == 'edited_message' else {'id': 'x', 'chat_instance': 'x',
                   'from': {'id': 1, 'is_bot': False, 'first_name': 'Fixture'}, 'message': msg}}
            await incoming_topic_message(Update.de_json(data, None), context)
        self.assertEqual(activity.note.call_count, 0)
        await incoming_topic_message(Update.de_json({'update_id': 2, 'message': msg}, None), context)
        self.assertEqual(activity.note.call_count, 1)
        activity.note.side_effect = RuntimeError('fixture')
        wrapper = TopicMessageObserver(activity)
        callback = AsyncMock(return_value=msg)
        self.assertIs(await wrapper.process_request(callback, (), {}, 'sendMessage', {}, None), msg)
        callback.assert_awaited_once()
        activity.note.reset_mock()
        with self.assertRaises(RuntimeError):
            await wrapper.process_request(AsyncMock(side_effect=RuntimeError('send failed')), (), {}, 'sendMessage', {}, None)
        activity.note.assert_not_called()

    async def test_registry_event_endpoint_auth_and_validation(self):
        scratch = Path(__file__).resolve().parent.parent / 'tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as home:
            storage = Storage(Path(home) / 'bot.db')
            activity = SimpleNamespace(note=Mock())
            server = make_registry_server(storage, '127.0.0.1', 0, 'fixture',
                                          loop=asyncio.get_running_loop(), activity=activity)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{server.server_port}') as client:
                    event = {'chat_id': -100123, 'message_thread_id': 42, 'message_id': 10}
                    self.assertEqual((await client.post('/topic-message', json=event)).status_code, 401)
                    self.assertEqual((await client.post('/topic-message', json={}, headers={'Authorization': 'Bearer fixture'})).status_code, 400)
                    self.assertEqual((await client.post('/topic-message', json=event, headers={'Authorization': 'Bearer fixture'})).status_code, 200)
                    await asyncio.sleep(0)
                    activity.note.assert_called_once_with(event)
            finally:
                await asyncio.to_thread(server.shutdown)
                server.server_close()
                thread.join(timeout=2)
                storage.close()


if __name__ == '__main__':
    unittest.main()
