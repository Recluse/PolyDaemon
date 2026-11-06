"""What the bot makes of a plugin's /inject answer, and where unattended commands are never typed."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from bot import inject
from bridge.client import ChannelPluginClient, InstanceConfig
from bridge.registry import RuntimeInstance


def client_answering(status, body):
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(status, json=body) if body is not None else httpx.Response(status, text='not json')

    client = ChannelPluginClient([InstanceConfig('w', '198.51.100.5', 3100, 't')])
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client, seen


class PostInjectOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_answers_map_to_outcomes(self):
        cases = [
            (200, {'ok': True, 'outcome': 'confirmed'}, 'confirmed', True),
            (200, {'ok': True, 'outcome': 'unconfirmed'}, 'unconfirmed', True),
            # A plugin too old to say what happened only typed the keys.
            (200, {'ok': True}, 'unconfirmed', True),
            (409, {'ok': False, 'outcome': 'as_text', 'reason': 'plain prompt'}, 'as_text', False),
            (409, {'ok': False, 'outcome': 'refused', 'reason': 'not empty'}, 'refused', False),
            (501, {'ok': False, 'outcome': 'unsupported'}, 'unsupported', False),
            (409, {'ok': False, 'reason': 'no parent pid'}, 'failed', False),
            (500, None, 'failed', False),
        ]
        for status, body, outcome, ok in cases:
            with self.subTest(status=status, body=body):
                client, seen = client_answering(status, body)
                self.assertEqual((await client.post_inject_outcome('w', '/compact'))[0], outcome)
                self.assertEqual(seen[-1], {'text': '/compact'})
                self.assertEqual((await client.post_inject('w', '/compact'))[0], ok)

    async def test_unattended_asks_for_an_empty_prompt(self):
        client, seen = client_answering(200, {'ok': True, 'outcome': 'confirmed'})
        await client.post_inject_outcome('w', '/compact', require_empty_prompt=True)
        self.assertEqual(seen[-1], {'text': '/compact', 'require_empty_prompt': True})

    async def test_unknown_window_and_transport_error_are_failures(self):
        client, _ = client_answering(200, {'ok': True})
        self.assertEqual((await client.post_inject_outcome('nobody', '/compact'))[0], 'failed')

        def boom(request):
            raise httpx.ConnectError('down')
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(boom))
        self.assertEqual((await client.post_inject_outcome('w', '/compact'))[0], 'failed')


class UnattendedDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_console_is_never_typed_into(self):
        inst = RuntimeInstance('w', 'w', 'w', '127.0.0.1', 3100, 't', '/work/w')
        typed = patch.object(inject, 'inject_window_text').start()
        self.addCleanup(patch.stopall)
        outcome, _ = await inject.deliver_unattended_slash_command(SimpleNamespace(), [inst], inst.key, '/compact')
        self.assertEqual(outcome, 'unsupported')
        typed.assert_not_called()

    async def test_remote_window_goes_through_the_plugin_with_the_empty_prompt_requirement(self):
        inst = RuntimeInstance('w', 'w', 'w', '198.51.100.5', 3100, 't', '/work/w')
        client = SimpleNamespace(post_inject_outcome=AsyncMock(return_value=('refused', 'not empty')))
        with patch('bot.common.get_bridge_client', return_value=client):
            outcome = await inject.deliver_unattended_slash_command(SimpleNamespace(), [inst], inst.key, '/compact')
        self.assertEqual(outcome, ('refused', 'not empty'))
        self.assertTrue(client.post_inject_outcome.await_args.kwargs['require_empty_prompt'])


if __name__ == '__main__':
    unittest.main()
