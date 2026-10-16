import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sidebar', Path(__file__).with_name('codex-sidebar.py'))
sidebar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidebar)


class Sidebar(unittest.TestCase):
    def test_connection_capability_and_context_are_separate(self):
        data = {'session': {'model': 'fixture', 'status': 'idle', 'branch': 'main', 'agents': []},
                'context': {'tokens': 12000, 'window': 128000},
                'bridge': {'state': 'connected', 'details': False},
                'memory': {'available': False, 'connection': 'connected', 'reason': 'project_status not exposed'},
                'limits': [{'label': 'codex', 'minutes': 10080, 'used': 90, 'resetsAt': 2000000000}]}
        text = '\n'.join(t for t, _ in sidebar.rows(data))
        self.assertIn('Weekly / codex', text)
        self.assertNotIn('10080m', text)
        self.assertIn('Context: 12,000 / 128,000 (9%)', text)
        self.assertIn('MCP: connected', text)
        self.assertIn('Counts / freshness: unknown', text)
        self.assertNotIn('0 docs', text)
        self.assertNotIn('Topic: pending', text)
        self.assertEqual(sidebar.duration(300), '5h')

    def test_unknown_and_zero_are_distinct(self):
        unknown = '\n'.join(t for t, _ in sidebar.rows({}))
        self.assertIn('Session: unavailable', unknown)
        self.assertNotIn('0 docs', unknown)
        data = {'session': {'model': 'fixture', 'status': 'idle', 'branch': 'main', 'agents': [], 'more': False}}
        self.assertIn(('No direct child agents', None), sidebar.rows(data))

    def test_agents_have_stable_ids_and_text_is_terminal_safe(self):
        data = {'session': {'model': 'fixture', 'status': 'idle', 'branch': 'main', 'more': False,
                            'agents': [{'id': 'child', 'name': '\x1b]52;payload', 'role': 'review', 'status': 'active'}]}}
        text, key = next((t, k) for t, k in sidebar.rows(data) if k)
        self.assertEqual(key, 'child')
        self.assertNotIn('\x1b', text)
        self.assertNotIn('\x07', sidebar.safe('\x07'))


if __name__ == '__main__':
    unittest.main()
