import unittest
from unittest.mock import AsyncMock, patch

from telegram import Update
from bot.messages import _describe_unhandled, unhandled_message


class PinnedMessageTests(unittest.TestCase):
    def message(self, pinned):
        return Update.de_json({'update_id': 1, 'message': {
            'message_id': 20, 'date': 1,
            'from': {'id': 1, 'is_bot': False, 'first_name': 'Fixture'},
            'chat': {'id': -100123, 'type': 'supergroup'},
            'message_thread_id': 42, 'pinned_message': {
                'message_id': 19, 'date': 1,
                'chat': {'id': -100123, 'type': 'supergroup'}, **pinned,
            },
        }}, None).effective_message

    def test_native_service_text(self):
        result = _describe_unhandled(self.message({'text': 'Saved context'}))
        self.assertIn('закреплено сообщение #19', result)
        self.assertIn('не новое поручение', result)
        self.assertIn('Saved context', result)
        self.assertNotIn('неподдерживаемого', result)

    def test_caption_and_bounded_context(self):
        result = _describe_unhandled(self.message({'caption': 'x' * 3000}))
        self.assertIn('x' * 2000, result)
        self.assertNotIn('x' * 2001, result)
        self.assertIn('текст сокращён', result)

    def test_inaccessible_or_no_text(self):
        for data in ({'date': 0}, {}):
            with self.subTest(data=data):
                result = _describe_unhandled(self.message(data))
                self.assertIn('закреплено сообщение #19', result)
                self.assertIn('недоступны', result)


class PinnedForwardingTests(unittest.IsolatedAsyncioTestCase):
    async def test_service_context_forwarded_once_without_body_logging(self):
        message = PinnedMessageTests().message({'text': 'private fixture context'})
        update = Update(update_id=1, message=message)
        context = object()
        with patch('bot.messages._resolve_topic_target', return_value='fixture-window'), \
                patch('bot.messages._forward_message', new_callable=AsyncMock) as forward, \
                self.assertLogs('bot.messages', level='INFO') as logs:
            await unhandled_message(update, context)
        forward.assert_awaited_once_with(
            update, context, text=_describe_unhandled(message), topic_target='fixture-window',
        )
        rendered = '\n'.join(logs.output)
        self.assertIn('pinned_message_id=19', rendered)
        self.assertIn('message_id=20', rendered)
        self.assertNotIn('private fixture context', rendered)


if __name__ == '__main__':
    unittest.main()
