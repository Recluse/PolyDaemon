"""Observe new topic messages without delaying delivery or making approval decisions."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
import logging

from telegram.ext import BaseRateLimiter

from bot.topics import resolve_workspace_id
from bridge.registry import load_runtime_instances

logger = logging.getLogger(__name__)


def is_prompt(markup) -> bool:
    if hasattr(markup, 'to_dict'):
        markup = markup.to_dict()
    if not isinstance(markup, dict):
        return False
    if markup.get('force_reply') is True:
        return True
    return any(isinstance(button, dict) and str(button.get('callback_data', '')).startswith(('approve:', 'ask:', 'plan:'))
               for row in markup.get('inline_keyboard', []) if isinstance(row, (list, tuple))
               for button in row)


def valid_event(event) -> bool:
    return (isinstance(event, dict) and all(type(event.get(k)) is int for k in ('chat_id', 'message_thread_id', 'message_id'))
            and event['chat_id'] != 0 and event['message_thread_id'] > 0 and event['message_id'] > 0)


class TopicActivity:
    def __init__(self, config, storage, client):
        self.config, self.storage, self.client = config, storage, client
        self.seen = OrderedDict()
        self.jobs = set()

    def note(self, event):
        if not valid_event(event):
            return
        key = tuple(event[k] for k in ('chat_id', 'message_thread_id', 'message_id'))
        if key in self.seen:
            return
        self.seen[key] = None
        if len(self.seen) > 4096:
            self.seen.popitem(last=False)
        try:
            self.storage.record_compact_activity(*key)
        except Exception:
            # Failed persistence cannot re-arm compaction; reminders still flow.
            logger.warning('topic activity persistence failed; automatic compaction not re-armed')
        job = asyncio.create_task(self._deliver(dict(event)))
        self.jobs.add(job)
        job.add_done_callback(self.jobs.discard)

    async def _deliver(self, event):
        try:
            targets = {}
            for instance in load_runtime_instances(self.config, self.storage, keep_duplicates=True):
                binding = self.storage.get_topic(resolve_workspace_id(instance))
                if binding and (binding[0], binding[1]) == (event['chat_id'], event['message_thread_id']):
                    targets[(instance.host, instance.port)] = instance
            await asyncio.gather(*(self.client.post_topic_activity(i, event) for i in targets.values()))
        except Exception:
            logger.warning('topic activity notification failed; window/approval state unchanged')

    async def close(self):
        jobs = list(self.jobs)
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


class TopicMessageObserver(BaseRateLimiter):
    """PTB's supported API callback wrapper; no throttling or retry policy changes."""
    def __init__(self, activity):
        self.activity = activity

    async def initialize(self):
        pass

    async def shutdown(self):
        await self.activity.close()

    async def process_request(self, callback, args, kwargs, endpoint, data, rate_limit_args):
        result = await callback(*args, **kwargs)
        try:
            excluded = isinstance(rate_limit_args, dict) and rate_limit_args.get('topic_activity') is False
            if not excluded and (endpoint.startswith('send') or endpoint in ('copyMessage', 'forwardMessage')) and not is_prompt(data.get('reply_markup')):
                for message in result if isinstance(result, list) else [result]:
                    if isinstance(message, dict):
                        self.activity.note({
                            'chat_id': int((message.get('chat') or {}).get('id', data.get('chat_id', 0))),
                            'message_thread_id': message.get('message_thread_id', data.get('message_thread_id', 0)),
                            'message_id': message.get('message_id'),
                        })
        except Exception:
            logger.warning('outbound topic observation failed; send already succeeded')
        return result


async def incoming_topic_message(update, context):
    # Edited messages and callback queries refer to old cards, not new messages.
    try:
        message = update.message
        if message is not None and not is_prompt(message.reply_markup):
            context.application.bot_data['topic_activity'].note({
                'chat_id': message.chat_id, 'message_thread_id': message.message_thread_id,
                'message_id': message.message_id,
            })
    except Exception:
        logger.warning('incoming topic observation failed; message delivery unchanged')
