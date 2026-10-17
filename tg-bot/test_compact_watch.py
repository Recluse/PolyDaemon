"""Automatic compaction consumes topic activity durably, even on uncertain delivery."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, call, patch

from bot import compact_watch as watch
from bot.storage import Storage
from bridge.registry import RuntimeInstance


class CompactWatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parent.parent / 'tmp'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'bot.db'
        self.storage = Storage(self.path)
        self.addCleanup(lambda: self.storage.close())
        self.clock = patch('bot.storage.time.time', return_value=10000).start()
        self.addCleanup(patch.stopall)
        self.inst = RuntimeInstance('project', 'project', 'project', '127.0.0.1', 3100, 'fixture', '/work/project')
        self.storage.upsert_topic(self.inst.cwd, -100123, 10, 'Project')
        self.info = {'used': 500_000, 'idle_s': 9000, 'uptime_s': 10000, 'busy': False}
        self.client = SimpleNamespace(get_context=AsyncMock(return_value=self.info))
        self.context = SimpleNamespace(application=SimpleNamespace(bot_data={
            'config': {}, 'storage': self.storage, 'bridge_client': self.client,
        }), bot=SimpleNamespace(send_message=AsyncMock()))
        self.instances = patch.object(watch, 'refresh_instances', return_value=[self.inst]).start()
        self.inject = patch.object(watch, 'deliver_slash_command', new_callable=AsyncMock,
                                   return_value=(True, '')).start()

    def message(self, message_id=1, chat=-100123, topic=10, at=1000):
        now = self.clock.return_value
        self.clock.return_value = at
        self.storage.record_compact_activity(chat, topic, message_id)
        self.clock.return_value = now

    async def tick(self):
        await watch.compact_watch_job(self.context)

    def restart(self):
        self.storage.close()
        self.storage = Storage(self.path)
        self.context.application.bot_data = {'config': {}, 'storage': self.storage, 'bridge_client': self.client}

    async def test_one_attempt_one_note_survives_restart_usage_changes_and_window_replacement(self):
        self.message()
        await self.tick()
        self.inject.assert_awaited_once()
        self.context.bot.send_message.assert_awaited_once()
        self.assertEqual(self.context.bot.send_message.await_args.kwargs['rate_limit_args'], {'topic_activity': False})
        self.restart()
        self.clock.return_value += 86400
        self.instances.return_value = [RuntimeInstance('replacement', 'project', 'project', '127.0.0.2', 4000, 'fixture', self.inst.cwd)]
        for used in [500_000, 100_000, 900_000, 0, None]:
            self.info['used'] = used
            await self.tick()
        self.assertEqual(self.inject.await_count, 1)
        self.assertEqual(self.context.bot.send_message.await_count, 1)

    async def test_only_new_same_topic_message_rearms_after_topic_idle_period(self):
        self.message(); await self.tick()
        self.clock.return_value += 86400
        for chat, topic, mid in [(-100123, 11, 900), (-100456, 10, 900), (-100123, 10, 1)]:
            self.message(mid, chat, topic, self.clock.return_value)
            await self.tick()
        self.assertEqual(self.inject.await_count, 1)
        self.message(2, at=self.clock.return_value)
        await self.tick()
        self.assertEqual(self.inject.await_count, 1)
        self.clock.return_value += 7200
        await self.tick()
        self.assertEqual(self.inject.await_count, 2)
        await self.tick()
        self.assertEqual(self.inject.await_count, 2)

    async def test_no_observed_activity_including_legacy_database_never_dispatches(self):
        self.storage.set_compact_giveup(self.inst.key, 500_000)
        self.restart()
        await self.tick()
        self.inject.assert_not_awaited()
        self.client.get_context.assert_not_awaited()
        self.message(); await self.tick()
        self.inject.assert_awaited_once()

    async def test_transport_failure_or_ambiguous_timeout_remains_consumed(self):
        for mid, failure in enumerate([(False, 'transport unavailable'), RuntimeError('timeout')], 1):
            with self.subTest(failure=str(failure)):
                self.message(mid)
                self.inject.reset_mock()
                self.inject.side_effect = failure if isinstance(failure, Exception) else None
                self.inject.return_value = failure
                await self.tick()
                self.restart()
                self.clock.return_value += 86400
                await self.tick()
                self.inject.assert_awaited_once()
                self.context.bot.send_message.assert_not_awaited()

    async def test_cancellation_after_reservation_cannot_repeat(self):
        self.message()
        self.inject.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.tick()
        self.restart()
        self.inject.side_effect = None
        self.clock.return_value += 86400
        await self.tick()
        self.inject.assert_awaited_once()

    async def test_failed_notification_does_not_repeat_command_or_notification(self):
        self.message()
        self.context.bot.send_message.side_effect = RuntimeError('Telegram offline')
        await self.tick()
        self.restart()
        self.clock.return_value += 86400
        await self.tick()
        self.inject.assert_awaited_once()
        self.context.bot.send_message.assert_awaited_once()

    async def test_activity_or_rebinding_during_context_read_prevents_dispatch(self):
        self.message()
        async def arrival(_):
            self.message(2, at=self.clock.return_value)
            return self.info
        self.client.get_context.side_effect = arrival
        await self.tick()
        self.inject.assert_not_awaited()
        self.clock.return_value += 7200
        async def rebind(_):
            self.storage.upsert_topic(self.inst.cwd, -100123, 20, 'Other topic')
            return self.info
        self.client.get_context.side_effect = rebind
        await self.tick()
        self.inject.assert_not_awaited()

    async def test_concurrent_jobs_dispatch_once(self):
        self.message()
        barrier, reads = asyncio.Event(), 0
        async def read(_):
            nonlocal reads
            reads += 1
            if reads == 2:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), timeout=1)
            return self.info
        self.client.get_context.side_effect = read
        await asyncio.gather(self.tick(), self.tick())
        self.inject.assert_awaited_once()

    async def test_two_database_connections_claim_atomically(self):
        self.message()
        other = Storage(self.path)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(s.claim_compact_attempt, -100123, 10, 7200) for s in (self.storage, other)]
                self.assertEqual(sum(f.result() for f in futures), 1)
        finally:
            other.close()

    async def test_unknown_telemetry_and_busy_are_never_eligible(self):
        self.message()
        baseline = dict(self.info)
        for field, values in {
            'used': [None, True, '500000', -1, 500_000.5, float('nan')],
            'busy': [None, 0, 'false', True],
            'idle_s': [None, True, '9000', -1, float('nan'), float('inf'), 30],
            'uptime_s': [None, True, '9000', -1, float('nan'), float('inf'), 30],
        }.items():
            for value in values:
                self.client.get_context.return_value = {**baseline, field: value}
                await self.tick()
        self.inject.assert_not_awaited()
        self.client.get_context.return_value = baseline
        await self.tick()
        self.inject.assert_awaited_once()

    async def test_agent_aware_topics_closed_topics_and_no_topic(self):
        self.message()
        agents = [RuntimeInstance(f'project-{agent}', f'project-{agent}', f'project-{agent}', '127.0.0.1',
                                 3101 + n, 'fixture', self.inst.cwd) for n, agent in enumerate(['codex', 'opencode', 'mimo'])]
        self.instances.return_value = [*agents, self.inst]
        self.storage.set_topic_closed(self.inst.cwd, True)
        await self.tick()
        self.inject.assert_not_awaited()
        self.storage.set_topic_closed(self.inst.cwd, False)
        await self.tick()
        self.assertEqual(self.client.get_context.await_args_list, [call(self.inst.key)])
        self.assertEqual(self.context.bot.send_message.await_args.kwargs['message_thread_id'], 10)
        self.instances.return_value = [RuntimeInstance('other', 'other', 'other', '127.0.0.1', 3111, 'fixture', '/work/no-topic')]
        await self.tick()
        self.assertEqual(self.inject.await_count, 1)

    async def test_storage_failure_never_dispatches(self):
        self.message()
        with patch.object(self.storage, 'claim_compact_attempt', side_effect=RuntimeError('db offline')):
            await self.tick()
        self.inject.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
