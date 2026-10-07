"""Exercise the real hook against an isolated local approval endpoint."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    requests = []
    decision = "allow"

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            assert self.path == "/approve-request"
            assert self.headers["Authorization"] == "Bearer test-only"
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"decision": decision, "reason": "test"}).encode())

        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory() as home, ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            registry = Path(home) / ".tg-bridge-channel" / "instances.json"
            registry.parent.mkdir()
            registry.write_text(json.dumps({"test": {
                "cwd": home, "workspace_name": "test-codex", "parent_pid": os.getpid(),
                "port": server.server_port, "auth_token": "test-only",
                "heartbeat_at": 9999999999,
            }}))
            env = {**os.environ, "HOME": home, "CODEX_THREAD_ID": "test", "TG_WINDOW_UID": ""}

            def run(event, command="pwd", *, tool="Bash", args=None, cwd=home):
                result = subprocess.run(
                    ["node", str(Path(__file__).with_name("tg-approve.js"))],
                    input=json.dumps({"hook_event_name": event, "cwd": cwd,
                                      "turn_id": "test", "tool_name": tool,
                                      "tool_input": args if args is not None else {"command": command}}),
                    text=True, capture_output=True, env=env, timeout=5, check=True,
                )
                return json.loads(result.stdout)["hookSpecificOutput"] if result.stdout else None

            assert run("PreToolUse") is None
            assert requests == [], "routine PreToolUse must not ask"
            for decision in ("allow", "deny"):
                output = run("PermissionRequest")
                assert output["hookEventName"] == "PermissionRequest"
                assert output["decision"]["behavior"] == decision
                assert requests[-1]["sensitive"] is True, "native approvals must not use bypass"
            assert len(requests) == 2
            for prefix in ("mcp__tg-bridge__", "mcp__tg_bridge__"):
                for name in ("tell_window", "ask_window", "task_done", "edit_message"):
                    assert run("PreToolUse", tool=prefix + name) is None
                    assert run("PermissionRequest", tool=prefix + name)["decision"]["behavior"] == "allow"
            for command in ("gh pr merge 123", "rm -rf build", "rm one two",
                            "git check-ignore tmp/.local-test-artifacts/push-byteguard-review.log tmp/.local-test-artifacts/push-byteguard-independent.log",
                            "git --no-pager check-ignore push", "git grep push",
                            "rg -n 'B02|DATA_BACKEND=memory' scripts/deploy-local.sh",
                            "sed -n '1,170p' scripts/deploy-local.sh",
                            "cat scripts/deploy-local.sh", "bash -n scripts/deploy-local.sh"):
                assert run("PreToolUse", command) is None
            assert len(requests) == 2, "communication and local routine actions must not ask"
            inside = Path(home) / "nested"
            inside.mkdir()
            assert run("PreToolUse", tool="Write", args={"file_path": str(inside / "new")}) is None
            assert run("PreToolUse", cwd=str(inside)) is None
            assert len(requests) == 2
            outside = str(Path(home).parent / "outside")
            (inside / "link").symlink_to(Path(home).parent, target_is_directory=True)
            for tool, args in (
                ("exec_command", {"cmd": "git push origin main"}),
                ("exec_command", {"cmd": "./deploy-prod.sh"}),
                ("exec_command", {"cmd": "bash scripts/deploy-local.sh"}),
                ("exec_command", {"cmd": "rg --pre=./deploy-prod.sh text README.md"}),
                ("exec_command", {"cmd": "rg text README.md && ./deploy-prod.sh"}),
                ("exec_command", {"cmd": "cat README.md\n./deploy-prod.sh"}),
                ("exec_command", {"cmd": "/tmp/cat scripts/deploy-local.sh"}),
                ("exec_command", {"cmd": "cat $(./deploy-prod.sh)"}),
                ("exec_command", {"cmd": 'cat "$(./deploy-prod.sh)"'}),
                ("exec_command", {"cmd": "cat `./deploy-prod.sh`"}),
                ("exec_command", {"cmd": "sed -n '1,170p' -e 'e ./deploy-prod.sh' README.md"}),
                ("Bash", {"command": "pwd", "dangerouslyDisableSandbox": True}),
                ("Read", {"file_path": outside}),
                ("Write", {"file_path": str(inside / "link" / "new-file")}),
                ("exec_command", {"cmd": "pwd", "workdir": outside}),
                ("apply_patch", "*** Begin Patch\n*** Add File: " + outside + "\n+x\n*** End Patch"),
                ("apply_patch", {"input": "*** Begin Patch\n*** Update File: local\n*** Move to: " + outside + "\n*** End Patch"}),
            ):
                before = len(requests)
                assert run("PreToolUse", tool=tool, args=args)["permissionDecision"] == "deny"
                assert len(requests) == before + 1
                assert requests[-1]["sensitive"] is True
            before = len(requests)
            registry.write_text("{}")
            assert run("PermissionRequest") is None, "no route must retain the native prompt"
            assert run("PreToolUse", "git push")["permissionDecision"] == "deny"
            assert len(requests) == before
        finally:
            server.shutdown()
            thread.join()
    print("approval hook integration check OK")


if __name__ == "__main__":
    main()
