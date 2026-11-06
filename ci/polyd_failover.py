#!/usr/bin/env python3
"""Single-active router controller for the PolyDaemon bot hosts (fail-closed).

One instance runs on each bot host as a systemd service. It observes the pair
and only ever acts in the safe direction on its own:

  reserve: router up and a peer also reports router up -> stop (self-heal).
  anything else (peer silent, local router down, primary down) -> log and
           record that an operator decision is needed. It never starts a
           router and never writes a grant into the activation permit.

Loss of reachability is not evidence that the other node stopped polling, and
a fresh local Bot API session on the other host would not get a 409 Conflict
from Telegram. So no tick promotes, reclaims or restores. Activation is the
explicit operator command

  polyd_failover.py --config C promote --operator-decision \
      --fencing-evidence /abs/evidence.json

It refuses unless the evidence file is fresh and names the fenced peer, and
unless no reachable peer reports a serving router. The controller cannot
verify the fencing itself: the evidence is the operator's attestation that
the steps of docs/runbooks/router-cutover.md (caller drain, old router and Bot
API session closed, durable state checkpoint) have been completed. Without it
the command fails closed.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import logging
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logger = logging.getLogger("polyd-failover")

TOKEN_HEADER = "X-Polyd-Failover-Token"


class Config:
    def __init__(self, raw: dict) -> None:
        self.node_id = str(raw["node_id"])
        self.role = str(raw["role"])
        if self.role not in ("primary", "reserve"):
            raise ValueError("role must be primary or reserve")
        self.control_listen = str(raw["control_listen"])
        self.control_token = str(raw["control_token"])
        if len(self.control_token) < 16:
            raise ValueError("control_token too short")
        self.peers = [str(p).rstrip("/") for p in raw["peers"]]
        if not self.peers:
            raise ValueError("peers must not be empty")
        self.local_health_url = str(raw["local_health_url"])
        self.permit_path = Path(raw["permit_path"])
        if self.permit_path.is_symlink():
            raise ValueError("permit_path must be the real permit file, not a symlink "
                             "(an atomic replace would swap the link, not its target)")
        self.deny_value = str(raw.get("deny_value", "maintenance"))
        self.start_cmd = [str(a) for a in raw["start_cmd"]]
        self.stop_cmd = [str(a) for a in raw["stop_cmd"]]
        if not self.start_cmd or not self.stop_cmd:
            raise ValueError("start_cmd and stop_cmd are required")
        pre = raw.get("pre_start_cmd")
        self.pre_start_cmd = [str(a) for a in pre] if pre else None
        if self.pre_start_cmd and _restores_state(self.pre_start_cmd):
            # State restore is runbook step 5 and is verified before readiness.
            # Re-running a restore inside promote would overwrite that verified
            # checkpoint with the newest online copy (stale pending receipts
            # then replay), and router_state.py snapshots do not even pass the
            # online-capture verifier polyd_state_sync uses.
            raise ValueError("pre_start_cmd must not restore router state; "
                             "restore is an operator runbook step before promote")
        self.promote_after_s = float(raw.get("promote_after_s", 90))
        self.probe_interval_s = float(raw.get("probe_interval_s", 15))
        self.probe_timeout_s = float(raw.get("probe_timeout_s", 4))
        self.demote_wait_s = float(raw.get("demote_wait_s", 30))
        self.state_path = Path(raw["state_path"])
        self.fencing_evidence_max_age_s = float(raw.get("fencing_evidence_max_age_s", 900))
        # The node a promotion of this host replaces; fencing evidence must name it.
        peer_node = str(raw.get("peer_node_id") or "").strip()
        self.peer_node_id = peer_node or None
        if self.peer_node_id == self.node_id:
            raise ValueError("peer_node_id must differ from node_id")


_STATE_TOOLS = re.compile(r"polyd_state_sync|router_state|router_online_backup")


def _restores_state(cmd: list[str]) -> bool:
    """Best-effort: any argv (script path, `-m pkg.module`, `sh -c` string)
    naming a state tool together with a `restore` subcommand word. Words are
    whole whitespace-separated tokens, so a path such as /backup/restore/x is
    not a subcommand. A wrapper script that hides both cannot be detected; the
    docs say pre_start is for read-only readiness checks only."""
    text = " ".join(cmd)
    words = {w.strip("'\";") for part in cmd for w in part.split()}
    return bool(_STATE_TOOLS.search(text)) and "restore" in words


EVIDENCE_ENV = "POLYD_FENCING_EVIDENCE"
EVIDENCE_FIELDS = ("fenced_node", "method", "verified_by", "verified_at")


def load_fencing_evidence(path: Path, max_age_s: float, self_node: str | None = None,
                          now: float | None = None, expected_node: str | None = None) -> dict:
    """Return the operator's fencing attestation or raise ValueError.

    This checks that the attestation exists, is complete and fresh. It cannot
    and does not prove that the old node is really fenced.
    """
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("fencing evidence path must be absolute")
    try:
        data = path.read_bytes()
        raw = json.loads(data.decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"fencing evidence unreadable: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("fencing evidence must be a JSON object")
    for key in EVIDENCE_FIELDS[:3]:
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            raise ValueError(f"fencing evidence lacks {key}")
    stamp = raw.get("verified_at")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
        raise ValueError("fencing evidence lacks a finite numeric verified_at")
    now = time.time() if now is None else now
    if stamp > now + 60:
        raise ValueError("fencing evidence is dated in the future")
    if now - stamp > max_age_s:
        raise ValueError("fencing evidence is stale; re-verify the old node is fenced")
    if self_node is not None and raw["fenced_node"].strip() == self_node:
        raise ValueError("fencing evidence names this node, not the old one")
    if expected_node is not None and raw["fenced_node"].strip() != expected_node:
        raise ValueError(f"fencing evidence names {raw['fenced_node']!r}, "
                         f"not the configured peer {expected_node!r}")
    raw["_sha256"] = hashlib.sha256(data).hexdigest()
    return raw


def probe(url: str, token: str, timeout: float) -> dict | None:
    """Return the peer's /state payload, or None when unreachable."""
    req = urllib.request.Request(url.rstrip("/") + "/state", method="GET")
    req.add_header(TOKEN_HEADER, token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def request_demote(url: str, token: str, timeout: float) -> bool:
    req = urllib.request.Request(url.rstrip("/") + "/demote", method="POST", data=b"")
    req.add_header(TOKEN_HEADER, token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return False


def router_up(url: str, timeout: float) -> bool:
    """Any HTTP response from the registry port means the router is serving."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return True
    except urllib.error.HTTPError:
        return True  # 401/404/501 still prove the listener is up
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


class Controller:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._peer_down_since: float | None = None
        self._last_action = "init"
        self._load_state()

    # -- persisted state (survives controller restarts) -------------------
    def _load_state(self) -> None:
        try:
            raw = json.loads(self.cfg.state_path.read_text())
            self._peer_down_since = raw.get("peer_down_since")
        except (OSError, ValueError):
            self._peer_down_since = None

    def _save_state(self) -> None:
        try:
            self.cfg.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.cfg.state_path.write_text(
                json.dumps({"peer_down_since": self._peer_down_since, "action": self._last_action}))
        except OSError:
            logger.exception("state save failed")

    # -- host-wide serialization ------------------------------------------
    @contextmanager
    def _exclusive(self, blocking: bool):
        """Serialize promote and stop across processes on this host.

        The daemon (tick, POST /demote) and an operator's promote CLI are
        separate processes with separate Controller objects; without this a
        demote that completes during a slow pre-start would be undone by the
        grant and start that follow it.
        """
        path = self.cfg.state_path.with_name(self.cfg.state_path.name + ".lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as handle:
            flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            try:
                fcntl.flock(handle.fileno(), flags)
            except BlockingIOError as exc:
                raise PermissionError("another promote/demote is in progress on this host") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    # -- actions ---------------------------------------------------------
    def _write_permit(self, value: str) -> None:
        path = self.cfg.permit_path
        if path.is_symlink():
            # Replacing a symlink swaps the link and leaves its target (what a
            # container or reader of the target sees) at the old grant.
            raise PermissionError(f"permit path {path} is a symlink; refusing to write")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(value + "\n")
        tmp.replace(path)

    def _run(self, cmd: list[str], env: dict[str, str] | None = None) -> bool:
        logger.info("run: %s", " ".join(cmd))
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                                  env={**os.environ, **env} if env else None)
        except (OSError, subprocess.SubprocessError) as exc:
            logger.error("command failed to start: %s", exc)
            return False
        if proc.returncode != 0:
            logger.error("command exit %s: %s%s", proc.returncode, proc.stdout[-400:], proc.stderr[-400:])
            return False
        return True

    def _load_evidence(self, evidence_path: Path) -> dict:
        try:
            return load_fencing_evidence(evidence_path, self.cfg.fencing_evidence_max_age_s,
                                         self.cfg.node_id, expected_node=self.cfg.peer_node_id)
        except ValueError as exc:
            raise PermissionError(str(exc)) from exc

    def _check_nobody_serving(self) -> None:
        for url in self.cfg.peers:
            state = probe(url, self.cfg.control_token, self.cfg.probe_timeout_s)
            if state and state.get("router_up"):
                raise PermissionError(f"peer {url} still reports a serving router; fence it first")
        if router_up(self.cfg.local_health_url, self.cfg.probe_timeout_s):
            raise PermissionError("a local router is already serving")

    def start_router(self, reason: str, evidence_path: Path, evidence_sha256: str,
                     permit_before: tuple | None = None) -> bool:
        """Start only on behalf of promote(); the evidence reaches pre_start."""
        env = {EVIDENCE_ENV: str(evidence_path)}
        if permit_before is None:
            permit_before = self._permit_signature()
        if self.cfg.pre_start_cmd and not self._run(self.cfg.pre_start_cmd, env):
            self._last_action = f"start:{reason}:pre_start-failed"
            logger.error("pre-start step failed; not starting the router")
            return False
        # Re-verify as the very last step before the grant, still under the
        # host lock: network probes first (they can take probe_timeout_s per
        # peer), then the evidence (stale or swapped meanwhile), then the
        # permit (a demote/operator deny written at any point so far).
        try:
            self._check_nobody_serving()
            if self._load_evidence(evidence_path)["_sha256"] != evidence_sha256:
                raise PermissionError("fencing evidence changed during promotion")
            if self._permit_signature() != permit_before:
                raise PermissionError("the permit changed during promotion (demote or operator); "
                                      "not granting")
        except PermissionError:
            self._last_action = f"start:{reason}:recheck-failed"
            raise
        self._write_permit(self.cfg.node_id)
        ok = self._run(self.cfg.start_cmd)
        if not ok:
            # A failed/timed-out start must not leave a grant behind for a
            # later CI deploy or restart policy to act on without evidence.
            self._write_permit(self.cfg.deny_value)
        self._last_action = f"start:{reason}:{'ok' if ok else 'fail'}"
        logger.warning("%s router on %s (%s)", "started" if ok else "FAILED to start",
                       self.cfg.node_id, reason)
        return ok

    def stop_router(self, reason: str) -> bool:
        with self._exclusive(blocking=True):
            ok = self._run(self.cfg.stop_cmd)
            self._write_permit(self.cfg.deny_value)
        self._last_action = f"stop:{reason}:{'ok' if ok else 'fail'}"
        logger.warning("%s router on %s (%s)", "stopped" if ok else "FAILED to stop",
                       self.cfg.node_id, reason)
        return ok

    # -- tick ------------------------------------------------------------
    def snapshot(self) -> dict:
        with self._lock:
            return {
                "node_id": self.cfg.node_id,
                "role": self.cfg.role,
                "router_up": router_up(self.cfg.local_health_url, self.cfg.probe_timeout_s),
                "permit": self._permit_value(),
                "last_action": self._last_action,
                "ts": time.time(),
            }

    def _permit_signature(self) -> tuple:
        """Content plus file identity. A deny written again with the same text
        (e.g. an operator repeating `maintenance` to cancel a promotion) still
        changes the inode or mtime, which content alone would miss."""
        try:
            st = self.cfg.permit_path.stat()
            return (self._permit_value(), st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            return (self._permit_value(), None, None, None)

    def _permit_value(self) -> str:
        try:
            return self.cfg.permit_path.read_text().strip()
        except OSError:
            return ""

    def tick(self) -> None:
        cfg = self.cfg
        now = time.time()
        peers = [probe(p, cfg.control_token, cfg.probe_timeout_s) for p in cfg.peers]
        reachable = [p for p in peers if p is not None]
        serving = [p for p in reachable if p.get("router_up")]
        local_up = router_up(cfg.local_health_url, cfg.probe_timeout_s)

        with self._lock:
            if not reachable:
                if self._peer_down_since is None:
                    self._peer_down_since = now
            else:
                self._peer_down_since = None

        if cfg.role == "primary":
            self._tick_primary(local_up, serving)
        else:
            self._tick_reserve(local_up, serving, reachable)

    def _needs_operator(self, reason: str) -> None:
        if self._last_action != f"needs-operator:{reason}":
            logger.error("NOT starting the router on %s: %s. Activation requires "
                         "'promote --operator-decision --fencing-evidence' after the "
                         "cutover runbook; reachability is not fencing.",
                         self.cfg.node_id, reason)
        self._last_action = f"needs-operator:{reason}"

    def _tick_primary(self, local_up: bool, serving: list[dict]) -> None:
        # Never rewrite the permit here: an operator's deny must stick.
        if local_up:
            return
        self._needs_operator("primary-router-down-peer-serving" if serving
                             else "primary-router-down")

    def _tick_reserve(self, local_up: bool, serving: list[dict], reachable: list[dict]) -> None:
        if local_up:
            if serving:
                self.stop_router("primary-serving")
            return
        with self._lock:
            down_since = self._peer_down_since
        if reachable or down_since is None:
            return
        if time.time() - down_since >= self.cfg.promote_after_s:
            self._needs_operator("peer-unreachable")

    # -- explicit operator promotion -------------------------------------
    def promote(self, operator_decision: bool, evidence_path: Path | None) -> bool:
        """Start the local router only with an operator decision and fresh fencing evidence."""
        with self._exclusive(blocking=False):
            return self._promote_locked(operator_decision, evidence_path)

    def _promote_locked(self, operator_decision: bool, evidence_path: Path | None) -> bool:
        if not operator_decision:
            raise PermissionError("promotion requires --operator-decision")
        if evidence_path is None:
            raise PermissionError("promotion requires --fencing-evidence")
        if not self.cfg.peer_node_id:
            raise PermissionError("promotion requires peer_node_id in the config")
        # The permit as the operator left it when asking for promotion: any
        # write after this point (a deny repeated during the FIRST probes too)
        # cancels the promotion.
        permit_before = self._permit_signature()
        evidence = self._load_evidence(evidence_path)
        self._check_nobody_serving()
        logger.warning("operator promotion on %s; fenced node %s via %s, verified by %s",
                       self.cfg.node_id, evidence["fenced_node"], evidence["method"],
                       evidence["verified_by"])
        return self.start_router("operator-promote", Path(evidence_path), evidence["_sha256"],
                                 permit_before=permit_before)


class ControlServer:
    def __init__(self, cfg: Config, controller: Controller) -> None:
        self.cfg = cfg
        self.controller = controller
        host, _, port = cfg.control_listen.rpartition(":")
        self.httpd = ThreadingHTTPServer((host or "0.0.0.0", int(port)), self._handler())

    def _handler(self):
        controller = self.controller
        cfg = self.cfg

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # quiet  # noqa: A002
                pass

            def _authed(self) -> bool:
                return self.headers.get(TOKEN_HEADER) == cfg.control_token

            def _send(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                if self.path.split("?", 1)[0].rstrip("/") != "/state":
                    self._send(404, {"ok": False})
                    return
                if not self._authed():
                    self._send(401, {"ok": False})
                    return
                self._send(200, controller.snapshot())

            def do_POST(self) -> None:  # noqa: N802
                if self.path.split("?", 1)[0].rstrip("/") != "/demote":
                    self._send(404, {"ok": False})
                    return
                if not self._authed():
                    self._send(401, {"ok": False})
                    return
                controller.stop_router("peer-demote-request")
                self._send(200, controller.snapshot())

        return Handler

    def serve_forever(self) -> None:
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()
        logger.info("control server on %s", self.cfg.control_listen)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--once", action="store_true", help="single tick, then exit")
    sub = parser.add_subparsers(dest="command")
    promote = sub.add_parser("promote", help="explicitly activate this node (operator only)")
    promote.add_argument("--operator-decision", action="store_true",
                         help="confirm this is a deliberate operator activation")
    promote.add_argument("--fencing-evidence", type=Path,
                         help="absolute path to the fencing attestation JSON")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    cfg = Config(json.loads(args.config.read_text()))
    controller = Controller(cfg)

    if args.command == "promote":
        try:
            ok = controller.promote(args.operator_decision, args.fencing_evidence)
        except PermissionError as exc:
            logger.error("promotion refused: %s", exc)
            return 2
        return 0 if ok else 1

    if args.once:
        controller.tick()
        logger.info("tick done: %s", controller.snapshot())
        return 0

    ControlServer(cfg, controller).serve_forever()
    logger.info("failover controller %s (%s) started", cfg.node_id, cfg.role)
    while True:
        try:
            controller.tick()
        except Exception:
            logger.exception("tick failed")
        time.sleep(cfg.probe_interval_s)


if __name__ == "__main__":
    sys.exit(main())
