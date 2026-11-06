#!/usr/bin/env python3
"""docs/ha-failover.md must not contradict the cutover runbook or the code."""
from __future__ import annotations

import json
import re
from urllib.parse import urlparse
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyd_failover as pf  # noqa: E402

DOC = Path(__file__).resolve().parents[1] / 'docs' / 'ha-failover.md'


class HaDoc(unittest.TestCase):
    def setUp(self) -> None:
        self.text = DOC.read_text(encoding='utf-8')
        self.flat = ' '.join(self.text.split())

    def test_no_automatic_promotion_or_replay_claims(self) -> None:
        for claim in ('promotes itself', 'keeps that from re-running side effects',
                      'Layer 3 is the safety net', 'reserve promotes only after every peer',
                      'watch the reserve promote', 'starts its own local bot-api session'):
            self.assertNotIn(claim, self.flat)

    def test_states_pending_replay_and_operator_promotion(self) -> None:
        self.assertIn('re-queues every `pending` receipt', self.flat)
        self.assertIn('promote --operator-decision --fencing-evidence', self.flat)
        self.assertIn('runbooks/router-cutover.md', self.flat)

    def test_ha_compose_example_declares_the_role_and_permit(self) -> None:
        import yaml
        blocks = re.findall(r'```yaml\n(.*?)```', self.text, re.S)
        services = [yaml.safe_load(b)['services'] for b in blocks if 'services:' in b]
        self.assertEqual(len(services), 1)
        (service,) = services[0].values()
        env = service['environment']
        self.assertIn(env['POLYDAEMON_NODE_ROLE'], ('primary', 'reserve'))
        self.assertTrue(env['POLYDAEMON_NODE_ID'])
        self.assertTrue(env['POLYDAEMON_ACTIVATION_FILE'].startswith('/'))
        self.assertEqual(service['restart'], 'no')
        # The controller probes local_health_url on the host: the registry port
        # must be published on loopback at that port.
        cfg_json = json.loads([b for b in re.findall(r'```json\n(.*?)```', self.text, re.S)
                               if '"node_id"' in b][0])
        health = urlparse(cfg_json['local_health_url'])
        self.assertEqual(health.hostname, '127.0.0.1')
        self.assertIn(f'127.0.0.1:{health.port}:8090', service.get('ports', []))
        # The controller's permit_path must live in the directory mounted at
        # the container's activation-file directory.
        cfg_block = [b for b in re.findall(r'```json\n(.*?)```', self.text, re.S) if '"node_id"' in b][0]
        permit_path = Path(json.loads(cfg_block)['permit_path'])
        mounts = dict(v.rsplit(':', 2)[:2] if v.count(':') == 2 else v.split(':', 1)
                      for v in service['volumes'])
        container_dir = str(Path(env['POLYDAEMON_ACTIVATION_FILE']).parent)
        host_dir = next(h for h, c in mounts.items() if c == container_dir)
        self.assertEqual(str(permit_path.parent), host_dir)
        self.assertEqual(permit_path.name, Path(env['POLYDAEMON_ACTIVATION_FILE']).name)

    def test_ci_and_controller_activate_the_ha_service_profile(self) -> None:
        import yaml
        repo = DOC.parents[1]
        block = [b for b in re.findall(r'```yaml\n(.*?)```', self.text, re.S) if 'services:' in b][0]
        (service,) = yaml.safe_load(block)['services'].values()
        profiles = service.get('profiles', [])
        self.assertTrue(profiles)
        steps = yaml.safe_load((repo / '.gitlab-ci.yml').read_text())['deploy']['script']
        up = [s for s in steps if 'compose' in s and ' up ' in s + ' ']
        self.assertEqual(len(up), 1)
        cfg = json.loads([b for b in re.findall(r'```json\n(.*?)```', self.text, re.S)
                          if '"node_id"' in b][0])
        for profile in profiles:
            self.assertIn(f'--profile {profile}', up[0])
            self.assertIn(profile, cfg['start_cmd'][cfg['start_cmd'].index('--profile') + 1])

    def test_gaps_stay_explicit(self) -> None:
        self.assertIn('Nothing here is distributed fencing', self.flat)
        multi = (DOC.parent / 'multi-machine.md').read_text(encoding='utf-8')
        self.assertIn('**standalone** single-host service', ' '.join(multi.split()))

    def test_controller_config_example_is_accepted(self) -> None:
        blocks = [b for b in re.findall(r'```json\n(.*?)```', self.text, re.S) if '"node_id"' in b]
        self.assertEqual(len(blocks), 1)
        cfg = pf.Config(json.loads(blocks[0]))
        self.assertEqual(cfg.fencing_evidence_max_age_s, 900)


if __name__ == '__main__':
    unittest.main()
