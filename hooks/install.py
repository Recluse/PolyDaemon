"""Register the PolyDaemon hooks in Claude Code's ~/.claude/settings.json.

    python3 hooks/install.py              # install / update
    python3 hooks/install.py --dry-run    # show what would change, write nothing
    python3 hooks/install.py --uninstall  # remove PolyDaemon's entries only
    python3 hooks/install.py --self-check
    python3 hooks/install.py --codex      # the same hooks for Codex (~/.codex/hooks.json)
    python3 hooks/install.py --mcp        # register the plugin from ~/.config/polydaemon/machine.env
                                          # (see hooks/mcp_entry.py; --dry-run works here too)

The hooks run from THIS checkout (absolute paths), so `git pull` updates them;
there is no copy in ~/.claude/hooks to drift out of date.

What it guarantees, because settings.json is shared with everything else you run:
  - entries that are not PolyDaemon's are never touched;
  - re-running replaces PolyDaemon's entries instead of adding duplicates — an
    entry is recognised as ours by the hook FILE it runs, wherever that file
    lives, so an older hand-made copy (say in ~/.claude/hooks) is replaced too,
    and --dry-run shows exactly that before anything is written;
  - the previous file is kept as settings.json.bak-<timestamp> before any write.
"""
from __future__ import annotations

import copy
import json
import os
import pathlib
import re
import shutil
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
SETTINGS = pathlib.Path.home() / ".claude" / "settings.json"
# Codex reads hooks from its own file, in the same shape as Claude Code's
# "hooks" section. PreToolUse guards protected operations; PermissionRequest
# forwards native sandbox/network approvals, including otherwise routine tools.
CODEX_HOOKS_FILE = pathlib.Path.home() / ".codex" / "hooks.json"
CODEX_ENTRIES = {("PreToolUse", "hooks/tg-approve.js"),
                 ("PermissionRequest", "hooks/tg-approve.js"),
                 ("PreToolUse", "channel-plugin/hooks/pre-tool-use.ts")}

# The three hooks that WAIT for a human in Telegram. The plugin waits up to 24 h
# for an answer (APPROVAL_TIMEOUT_MS in channel-plugin/src/config.ts) and the
# hooks wait a little longer than that, so Claude's own timeout for them must be
# longer still. If Claude's timeout is SHORTER, it kills the hook while the
# question is still open in Telegram — and the tool call then goes ahead on
# Claude's normal permission flow, which in bypass mode means it simply runs.
# That undoes the one guarantee tg-approve.js exists for: merges and deploys
# only on a human's tap.
APPROVAL_HOOK_TIMEOUT_S = 24 * 60 * 60 + 5 * 60

# (event, matcher, runner, file relative to the repo, timeout seconds)
HOOKS = [
    ("PreToolUse", "*", "node", "hooks/tg-approve.js", APPROVAL_HOOK_TIMEOUT_S),
    # Claude Code's own "needs your permission" dialog (built-in safety checks
    # that a PreToolUse allow does not skip) — answered from Telegram too.
    ("PermissionRequest", "*", "node", "hooks/tg-approve.js", APPROVAL_HOOK_TIMEOUT_S),
    ("PreToolUse", "AskUserQuestion", "node", "hooks/tg-ask-question.js", APPROVAL_HOOK_TIMEOUT_S),
    ("PreToolUse", "ExitPlanMode", "node", "hooks/tg-exit-plan.js", APPROVAL_HOOK_TIMEOUT_S),
    ("PreToolUse", "", "bun", "channel-plugin/hooks/pre-tool-use.ts", 3),
    ("Notification", "", "node", "hooks/tg-notify.js", 10),
    ("Stop", "", "node", "hooks/tg-stop-mirror.js", 10),
]

# How an entry is recognised as ours: by the file it runs. The tg-*.js names are
# distinctive, so the bare name is enough — and it finds a previous install from
# another location, to be replaced rather than left running alongside. A generic
# name (pre-tool-use.ts is what many plugins call their hook) needs its folder
# too, or someone else's hook would be taken for ours and removed.
OUR_MARKERS = {
    pathlib.PurePath(rel).name if pathlib.PurePath(rel).name.startswith("tg-") else rel
    for _, _, _, rel, _ in HOOKS
}


def _is_ours(hook: dict) -> bool:
    # Any run of slashes/backslashes counts as one separator: an entry written by
    # hand on Windows can carry doubled backslashes, and was then not recognised
    # — so an install left it in place and added ours beside it.
    cmd = re.sub(r"[\\/]+", "/", str(hook.get("command") or ""))
    return any(marker in cmd for marker in OUR_MARKERS)


def _command(runner: str, rel: str, repo: pathlib.Path) -> str:
    return f'{runner} "{(repo / rel)}"'


def strip_ours(settings: dict) -> tuple[dict, list[str]]:
    """Settings with every PolyDaemon hook removed, plus what was removed."""
    out = copy.deepcopy(settings)
    removed: list[str] = []
    hooks = out.get("hooks") or {}
    for event in list(hooks):
        groups = []
        for group in hooks[event] or []:
            kept = []
            for h in group.get("hooks") or []:
                if _is_ours(h):
                    removed.append(f"{event} [{group.get('matcher', '')!r}] {h.get('command')}")
                else:
                    kept.append(h)
            if kept:                         # a group left empty is dropped, not kept hollow
                groups.append({**group, "hooks": kept})
        if groups:
            hooks[event] = groups
        else:
            del hooks[event]
    if hooks:
        out["hooks"] = hooks
    else:
        out.pop("hooks", None)
    return out, removed


def install(settings: dict, repo: pathlib.Path = REPO, entries: list | None = None) -> tuple[dict, list[str], list[str]]:
    out, removed = strip_ours(settings)
    hooks = out.setdefault("hooks", {})
    added = []
    for event, matcher, runner, rel, timeout in (HOOKS if entries is None else entries):
        cmd = _command(runner, rel, repo)
        hooks.setdefault(event, []).append({
            "matcher": matcher,
            "hooks": [{"type": "command", "command": cmd, "timeout": timeout}],
        })
        added.append(f"{event} [{matcher!r}] {cmd}  (timeout {timeout}s)")
    return out, removed, added


def _check_prereqs(repo: pathlib.Path) -> list[str]:
    missing = [rel for _, _, _, rel, _ in HOOKS if not (repo / rel).is_file()]
    return [f"missing hook file: {m}" for m in missing]


def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    # --check: say nothing, exit 0 if the hooks are exactly as this checkout would
    # install them and 3 if not — for the launch agent's /version.
    check = "--check" in argv
    uninstall = "--uninstall" in argv
    # Codex needs both the protected-operation guard and native approval forwarding.
    codex = "--codex" in argv
    SETTINGS = CODEX_HOOKS_FILE if codex else globals()["SETTINGS"]
    entries = [h for h in HOOKS if (h[0], h[3]) in CODEX_ENTRIES] if codex else None

    problems = _check_prereqs(REPO)
    if problems and not uninstall:
        print("\n".join(problems), file=sys.stderr)
        return 1

    current = {}
    if SETTINGS.exists():
        try:
            current = json.loads(SETTINGS.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            # Never overwrite a file we could not read: it is shared with every
            # other tool, and "invalid" may only mean "has a comment in it".
            print(f"{SETTINGS} is not valid JSON ({exc}); fix it first, nothing written.",
                  file=sys.stderr)
            return 1

    if uninstall:
        new, removed = strip_ours(current)
        added = []
    else:
        new, removed, added = install(current, entries=entries)

    if check:
        return 0 if new == current else 3
    for line in removed:
        print(f"  - {line}")
    for line in added:
        print(f"  + {line}")
    if new == current:
        print("nothing to change")
        return 0
    if dry:
        print("dry run: nothing written")
        return 0

    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    if SETTINGS.exists():
        backup = SETTINGS.with_name(f"{SETTINGS.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(SETTINGS, backup)      # keeps the mode: the file can hold secrets
        print(f"backup: {backup}")
    tmp = SETTINGS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if SETTINGS.exists():
        shutil.copymode(SETTINGS, tmp)
    os.replace(tmp, SETTINGS)               # atomic: never a half-written settings file
    print(f"{'removed from' if uninstall else 'written to'} {SETTINGS}")
    if codex:
        # Codex trusts hooks by a hash of each entry and does not run one it has
        # not been told to trust — a changed entry is off until confirmed.
        print("Codex runs only hooks you have trusted: in a Codex window run /hooks and "
              "trust the changed ones, or they stay OFF — the approval gate included.")
    return 0


def _self_check() -> None:
    repo = pathlib.Path("/opt/polydaemon")
    foreign = {"type": "command", "command": "python3 /opt/other/memory_hook.py", "timeout": 5}
    # Someone else's hook with the same generic file name as ours: not ours.
    foreign_same_name = {"type": "command", "command": "bun /opt/other/hooks/pre-tool-use.ts"}
    old_ours = {"type": "command", "command": 'node "/home/me/.claude/hooks/tg-approve.js"',
                "timeout": 660}
    settings = {
        "model": "keep-me",
        "hooks": {
            "PreToolUse": [
                {"matcher": "*", "hooks": [foreign, foreign_same_name]},
                {"matcher": "*", "hooks": [old_ours]},
            ],
            "SessionStart": [{"matcher": "", "hooks": [foreign]}],
        },
    }

    new, removed, added = install(settings, repo)
    assert new["model"] == "keep-me", "unrelated settings survive"
    assert len(removed) == 1 and "/home/me/.claude/hooks/tg-approve.js" in removed[0], \
        "an old copy elsewhere is found and replaced"
    assert len(added) == len(HOOKS)
    flat = [h for g in new["hooks"]["PreToolUse"] for h in g["hooks"]]
    assert foreign in flat, "a foreign PreToolUse hook is kept"
    assert new["hooks"]["SessionStart"] == settings["hooks"]["SessionStart"], \
        "a foreign event is left exactly as it was"
    approve = [h for h in flat if "tg-approve.js" in h["command"]]
    assert len(approve) == 1, "exactly one tg-approve after install"
    assert approve[0]["timeout"] == APPROVAL_HOOK_TIMEOUT_S, \
        "approval hooks outlive the plugin's 24 h wait"
    assert str(repo / "hooks" / "tg-approve.js") in approve[0]["command"]

    again, removed2, _ = install(new, repo)
    assert again == new, "re-running is a no-op, not a duplicate"
    assert len(removed2) == len(HOOKS)

    codex_entries = [h for h in HOOKS if (h[0], h[3]) in CODEX_ENTRIES]
    codex, _, _ = install(settings, repo, codex_entries)
    for event in ("PreToolUse", "PermissionRequest"):
        approvals = [h for g in codex["hooks"][event] for h in g["hooks"]
                     if "tg-approve.js" in h["command"]]
        assert len(approvals) == 1, f"Codex needs exactly one {event} approval hook"
    assert install(codex, repo, codex_entries)[0] == codex

    gone, removed3 = strip_ours(new)
    assert len(removed3) == len(HOOKS)
    left = [h for g in gone["hooks"]["PreToolUse"] for h in g["hooks"]]
    assert left == [foreign, foreign_same_name], "uninstall leaves only what was there before"
    assert _is_ours({"command": 'bun "C:\\\\repo\\\\channel-plugin\\\\hooks\\\\pre-tool-use.ts"'}), \
        "doubled backslashes, as a hand-written Windows entry has them"
    assert _is_ours({"command": 'bun "C:\\repo\\channel-plugin\\hooks\\pre-tool-use.ts"'}), \
        "our own generic-named hook is still recognised, Windows paths included"
    assert "Notification" not in gone["hooks"], "events left empty are removed, not left hollow"
    assert gone["hooks"]["SessionStart"] == settings["hooks"]["SessionStart"]

    empty, _ = strip_ours({})
    assert empty == {}, "nothing to remove from nothing"
    print("install self-check OK")


if __name__ == "__main__":
    import mcp_entry
    if "--codex" in sys.argv and "--opencode" in sys.argv:
        print("select one agent: --codex or --opencode", file=sys.stderr)
        sys.exit(2)
    if "--opencode" in sys.argv and "--mcp" not in sys.argv:
        print("OpenCode uses native plugin hooks: use --mcp --opencode", file=sys.stderr)
        sys.exit(2)
    if "--self-check" in sys.argv:
        _self_check()
        mcp_entry.self_check()
        sys.exit(0)
    if "--mcp" in sys.argv:
        if "--check" in sys.argv:
            print("--check is for the hooks; `claude mcp get tg-bridge` shows the MCP entry")
            sys.exit(2)
        if "--uninstall" in sys.argv:
            sys.exit(mcp_entry.uninstall("--codex" in sys.argv, "--dry-run" in sys.argv,
                                        "--opencode" in sys.argv, REPO))
        sys.exit(mcp_entry.main(REPO, "--dry-run" in sys.argv, "--codex" in sys.argv,
                               "--opencode" in sys.argv))
    sys.exit(main(sys.argv[1:]))
