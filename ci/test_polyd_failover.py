#!/usr/bin/env python3
"""Tests for the failover controller's decision rules."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyd_failover as pf  # noqa: E402

DEAD = "http://127.0.0.1:1"  # connection refused: a stopped router


def make_cfg(root: Path, role: str, peers: list[str], health: str,
             promote_after_s: float = 90) -> pf.Config:
    return pf.Config({
        "node_id": "node-" + role,
        "role": role,
        "control_listen": "127.0.0.1:0",
        "control_token": "t" * 20,
        "peers": peers,
        "local_health_url": health,
        "permit_path": str(root / "active-node"),
        "deny_value": "maintenance",
        "start_cmd": ["true"],
        "stop_cmd": ["true"],
        "promote_after_s": promote_after_s,
        "probe_interval_s": 0.05,
        "probe_timeout_s": 1,
        "demote_wait_s": 0.2,
        "state_path": str(root / "state.json"),
        "peer_node_id": "node-old",
    })


class Recording(pf.Controller):
    """Controller that records actions instead of running commands."""

    def __init__(self, cfg: pf.Config) -> None:
        super().__init__(cfg)
        self.actions: list[str] = []

    def _run(self, cmd: list[str], env: dict[str, str] | None = None) -> bool:
        self.actions.append(" ".join(cmd))
        return True


class StubServer:
    """Minimal peer control endpoint with a settable router_up flag."""

    def __init__(self) -> None:
        self.router_up = False
        self.demoted = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_GET(self) -> None:  # noqa: N802
                body = json.dumps({"node_id": "peer", "role": "reserve",
                                   "router_up": outer.router_up, "ts": 0}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                outer.router_up = False
                outer.demoted.set()
                body = b'{"ok": true}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class RouterStub:
    """A live router health endpoint; a stopped router is just an unreachable URL."""

    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

            def do_GET(self) -> None:  # noqa: N802
                self.send_response(200)
                self.end_headers()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class FailoverRules(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.stub = StubServer()
        self.router = RouterStub()

    def tearDown(self) -> None:
        self.stub.close()
        self.router.close()
        self.tmp.cleanup()

    def test_probe_unreachable(self) -> None:
        self.assertIsNone(pf.probe(DEAD, "t" * 20, 0.3))

    def test_probe_reachable(self) -> None:
        state = pf.probe(self.stub.url, "t" * 20, 1)
        self.assertIsNotNone(state)
        assert state is not None
        self.assertFalse(state["router_up"])

    def test_reserve_never_promotes_on_silence(self) -> None:
        # Regression: silence used to promote after promote_after_s. A partition
        # looks identical to a dead primary, so silence alone must never start.
        cfg = make_cfg(self.root, "reserve", [DEAD], DEAD, promote_after_s=0.05)
        ctl = Recording(cfg)
        ctl.tick()
        time.sleep(0.08)
        ctl.tick()
        ctl.tick()
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "")
        self.assertEqual(ctl._last_action, "needs-operator:peer-unreachable")

    def test_reserve_stays_down_while_primary_reachable(self) -> None:
        cfg = make_cfg(self.root, "reserve", [self.stub.url], DEAD,
                       promote_after_s=0.01)
        ctl = Recording(cfg)
        for _ in range(5):
            ctl.tick()
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "")

    def test_reserve_demotes_when_primary_serves(self) -> None:
        self.stub.router_up = True
        cfg = make_cfg(self.root, "reserve", [self.stub.url], self.router.url)
        ctl = Recording(cfg)
        ctl.tick()
        self.assertEqual(ctl.actions, ["true"])  # stop_cmd
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_primary_does_not_start_when_peer_down(self) -> None:
        cfg = make_cfg(self.root, "primary", [DEAD], DEAD)
        ctl = Recording(cfg)
        ctl.tick()
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "")

    def test_primary_does_not_reclaim_from_serving_peer(self) -> None:
        self.stub.router_up = True
        cfg = make_cfg(self.root, "primary", [self.stub.url], DEAD)
        ctl = Recording(cfg)
        ctl.tick()
        self.assertFalse(self.stub.demoted.is_set())
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "")

    def test_primary_keeps_operator_deny_while_router_up(self) -> None:
        cfg = make_cfg(self.root, "primary", [self.stub.url], self.router.url)
        ctl = Recording(cfg)
        ctl._write_permit("maintenance")
        ctl.tick()
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "maintenance")


class ConfigGuards(unittest.TestCase):
    def test_pre_start_restore_is_rejected(self) -> None:
        # Regression: the examples restored the newest online snapshot with
        # --force inside promote, after the runbook's verified restore.
        base = {"node_id": "n", "role": "reserve", "control_listen": "127.0.0.1:0",
                "control_token": "t" * 20, "peers": [DEAD], "local_health_url": DEAD,
                "permit_path": "/x/p", "start_cmd": ["s"], "stop_cmd": ["t"],
                "state_path": "/x/s"}
        for cmd in (["python3", "/h/bot-api/polyd_state_sync.py", "restore", "/a", "/b", "--force"],
                    ["python3", "router_state.py", "restore", "/a"],
                    ["python3", "-m", "ci.polyd_state_sync", "restore", "/a", "/b", "--force"],
                    ["python3", "-m", "polyd_state_sync", "restore", "/a", "/b"],
                    ["sh", "-c", "cd /h && python3 polyd_state_sync.py restore /a /b --force"],
                    ["python3", "-I", "/h/router_online_backup", "restore"]):
            with self.assertRaises(ValueError):
                pf.Config({**base, "pre_start_cmd": cmd})
        pf.Config({**base, "pre_start_cmd": ["python3", "/h/bot-api/polyd_state_sync.py",
                                             "verify-snapshot", "/a"]})
        # A read-only check of a snapshot kept under a folder named "restore".
        pf.Config({**base, "pre_start_cmd": ["python3", "polyd_state_sync.py", "verify-snapshot",
                                             "/backup/restore/checkpoint"]})

    def test_example_configs_load(self) -> None:
        folder = Path(__file__).resolve().parent / "deploy" / "failover"
        for name in ("failover-primary.example.json", "failover-reserve.example.json"):
            cfg = pf.Config(json.loads((folder / name).read_text()))
            self.assertIsNone(cfg.pre_start_cmd)
            self.assertTrue(cfg.peer_node_id)
            self.assertEqual(cfg.permit_path.parent.name, "permit")


class PermitSymlink(unittest.TestCase):
    def test_symlinked_permit_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "permit").mkdir()
            target = root / "permit" / "active-node"
            target.write_text("node-reserve\n")
            link = root / "active-node"
            link.symlink_to(target)
            raw = {"node_id": "n", "role": "reserve", "control_listen": "127.0.0.1:0",
                   "control_token": "t" * 20, "peers": [DEAD], "local_health_url": DEAD,
                   "permit_path": str(link), "start_cmd": ["s"], "stop_cmd": ["t"],
                   "state_path": str(root / "state.json")}
            with self.assertRaises(ValueError):
                pf.Config(raw)
            # Link created after start-up: the write itself must refuse.
            link.unlink()
            raw["permit_path"] = str(link)
            ctl = Recording(pf.Config(raw))
            link.symlink_to(target)
            with self.assertRaises(PermissionError):
                ctl.stop_router("peer-demote-request")
            self.assertTrue(link.is_symlink())
            self.assertEqual(target.read_text(), "node-reserve\n")


class GatedRecording(pf.Controller):
    """Controller whose command results can be scripted per call."""

    def __init__(self, cfg: pf.Config, results: list[bool] | None = None) -> None:
        super().__init__(cfg)
        self.actions: list[str] = []
        self.envs: list[dict[str, str] | None] = []
        self._results = list(results or [])

    def _run(self, cmd: list[str], env: dict[str, str] | None = None) -> bool:
        self.actions.append(" ".join(cmd))
        self.envs.append(env)
        hook = getattr(self, "hooks", {}).get(" ".join(cmd))
        if hook:
            hook()
        return self._results.pop(0) if self._results else True


def write_evidence(path: Path, fenced: str = "node-old", age_s: float = 0, **extra) -> Path:
    payload = {"fenced_node": fenced, "method": "router stopped, bot API close() returned true",
               "verified_by": "operator", "verified_at": time.time() - age_s, **extra}
    path.write_text(json.dumps(payload))
    return path


class OperatorPromotion(unittest.TestCase):
    """Only an explicit decision with fresh fencing evidence may start a router."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.stub = StubServer()
        self.router = RouterStub()

    def tearDown(self) -> None:
        self.stub.close()
        self.router.close()
        self.tmp.cleanup()

    def ctl(self, peers: list[str] | None = None, health: str = DEAD, results=None) -> GatedRecording:
        ctl = GatedRecording(make_cfg(self.root, "reserve", peers or [DEAD], health), results)
        ctl.cfg.pre_start_cmd = ["pre"]
        ctl.cfg.start_cmd = ["start"]
        return ctl

    def refused(self, ctl: GatedRecording, decision: bool, evidence: Path | None) -> None:
        with self.assertRaises(PermissionError):
            ctl.promote(decision, evidence)
        self.assertEqual(ctl.actions, [])
        self.assertEqual(ctl._permit_value(), "")

    def test_requires_operator_decision(self) -> None:
        self.refused(self.ctl(), False, write_evidence(self.root / "ev.json"))

    def test_requires_evidence(self) -> None:
        self.refused(self.ctl(), True, None)
        self.refused(self.ctl(), True, self.root / "missing.json")

    def test_rejects_stale_incomplete_or_self_evidence(self) -> None:
        self.refused(self.ctl(), True, write_evidence(self.root / "a.json", age_s=3600))
        self.refused(self.ctl(), True, write_evidence(self.root / "b.json", fenced="node-reserve"))
        self.refused(self.ctl(), True, write_evidence(self.root / "c.json", fenced=""))
        bad = self.root / "d.json"
        bad.write_text(json.dumps({"fenced_node": "node-old", "verified_at": time.time()}))
        self.refused(self.ctl(), True, bad)

    def test_evidence_must_name_the_configured_peer(self) -> None:
        self.refused(self.ctl(), True, write_evidence(self.root / "x.json", fenced="node-unrelated"))
        ctl = self.ctl()
        ctl.cfg.peer_node_id = None  # not configured: fail closed
        self.refused(ctl, True, write_evidence(self.root / "y.json"))

    def test_rejects_non_finite_verified_at(self) -> None:
        # json.loads accepts NaN/Infinity; NaN compared false and never went stale.
        for i, token in enumerate(('NaN', 'Infinity', '-Infinity')):
            path = self.root / f"nf{i}.json"
            path.write_text('{"fenced_node": "node-old", "method": "m", "verified_by": "o", '
                            f'"verified_at": {token}}}')
            self.refused(self.ctl(), True, path)

    def test_refuses_while_peer_serving(self) -> None:
        self.stub.router_up = True
        self.refused(self.ctl([self.stub.url]), True, write_evidence(self.root / "ev.json"))

    def test_refuses_while_local_router_up(self) -> None:
        self.refused(self.ctl(health=self.router.url), True, write_evidence(self.root / "ev.json"))

    def test_pre_start_failure_blocks_start(self) -> None:
        ctl = self.ctl(results=[False])
        self.assertFalse(ctl.promote(True, write_evidence(self.root / "ev.json")))
        self.assertEqual(ctl.actions, ["pre"])  # start_cmd never ran
        self.assertEqual(ctl._permit_value(), "")

    def test_promote_refuses_while_another_promote_or_demote_holds_the_lock(self) -> None:
        import fcntl
        ctl = self.ctl()
        lock = ctl.cfg.state_path.with_name(ctl.cfg.state_path.name + ".lock")
        with lock.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            self.refused(ctl, True, write_evidence(self.root / "ev.json"))

    def test_demote_during_pre_start_is_not_undone(self) -> None:
        # A demote arriving while pre-start runs must win: it waits for the
        # promotion and then stops the router and writes the deny value.
        ctl = self.ctl()
        demoter = self.ctl()
        finished = threading.Event()

        def demote_now() -> None:
            def run() -> None:
                demoter.stop_router("peer-demote-request")
                finished.set()
            threading.Thread(target=run, daemon=True).start()
            self.assertFalse(finished.wait(0.3), "demote ran in the middle of a promotion")

        ctl.hooks = {"pre": demote_now}
        ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertTrue(finished.wait(5))
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_permit_changed_during_pre_start_blocks_grant(self) -> None:
        ctl = self.ctl()
        ctl.hooks = {"pre": lambda: ctl._write_permit("maintenance")}
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_evidence_swapped_during_pre_start_blocks_grant(self) -> None:
        evidence = write_evidence(self.root / "ev.json")
        ctl = self.ctl()
        ctl.hooks = {"pre": lambda: write_evidence(evidence, method_note="swapped")}
        with self.assertRaises(PermissionError):
            ctl.promote(True, evidence)
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "")

    def test_evidence_going_stale_during_pre_start_blocks_grant(self) -> None:
        ctl = self.ctl()
        ctl.cfg.fencing_evidence_max_age_s = 1.0
        ctl.hooks = {"pre": lambda: time.sleep(0.4)}
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json", age_s=0.8))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "")

    def test_peer_serving_again_during_pre_start_blocks_grant(self) -> None:
        ctl = self.ctl([self.stub.url])
        ctl.hooks = {"pre": lambda: setattr(self.stub, "router_up", True)}
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "")

    def test_repeated_deny_during_first_probes_blocks_grant(self) -> None:
        ctl = self.ctl()
        ctl._write_permit("maintenance")
        calls = []
        original = ctl._check_nobody_serving

        def probe_round() -> None:
            calls.append(1)
            original()
            if len(calls) == 1:                  # the FIRST probe round, before pre-start
                time.sleep(0.01)
                ctl._write_permit("maintenance")
        ctl._check_nobody_serving = probe_round
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertNotIn("start", ctl.actions)
        self.assertEqual(ctl._permit_value(), "maintenance")

    def probing_ctl(self, during_final_probe) -> GatedRecording:
        """Controller whose second (final) probe round runs a side effect."""
        ctl = self.ctl()
        calls = []
        original = ctl._check_nobody_serving

        def probe_round() -> None:
            calls.append(1)
            original()
            if len(calls) == 2:
                during_final_probe(ctl)
        ctl._check_nobody_serving = probe_round
        return ctl

    def test_deny_written_during_final_probes_blocks_grant(self) -> None:
        ctl = self.probing_ctl(lambda c: c._write_permit("maintenance"))
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_repeated_deny_during_final_probes_blocks_grant(self) -> None:
        # The standby already holds the deny; the operator writes it AGAIN to
        # cancel the promotion. Same content, still a cancellation.
        ctl = self.probing_ctl(lambda c: (time.sleep(0.01), c._write_permit("maintenance")))
        ctl._write_permit("maintenance")
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json"))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_evidence_expiring_during_final_probes_blocks_grant(self) -> None:
        ctl = self.probing_ctl(lambda c: time.sleep(0.5))
        ctl.cfg.fencing_evidence_max_age_s = 1.0
        with self.assertRaises(PermissionError):
            ctl.promote(True, write_evidence(self.root / "ev.json", age_s=0.7))
        self.assertEqual(ctl.actions, ["pre"])
        self.assertEqual(ctl._permit_value(), "")

    def test_failed_start_revokes_the_grant(self) -> None:
        ctl = self.ctl(results=[True, False])  # pre ok, start_cmd fails or times out
        self.assertFalse(ctl.promote(True, write_evidence(self.root / "ev.json")))
        self.assertEqual(ctl.actions, ["pre", "start"])
        self.assertEqual(ctl._permit_value(), "maintenance")

    def test_promotes_with_decision_and_fresh_evidence(self) -> None:
        evidence = write_evidence(self.root / "ev.json")
        ctl = self.ctl()
        self.assertTrue(ctl.promote(True, evidence))
        self.assertEqual(ctl.actions, ["pre", "start"])
        self.assertEqual(ctl.envs[0], {pf.EVIDENCE_ENV: str(evidence)})
        self.assertEqual(ctl._permit_value(), "node-reserve")


if __name__ == "__main__":
    unittest.main()
