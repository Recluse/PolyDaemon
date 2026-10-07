"""/versions — which code every machine and every window is actually running.

An update has three places to land on each machine: the checkout (git pull), the
hooks registered in ~/.claude/settings.json (hooks/install.py), and every window,
which keeps running the plugin it started with until it restarts. Each can lag
on its own, and until now nothing showed which did — hooks on two machines turned
out to be months-old copies. This lists all three against the code the bot itself
was deployed from.
"""
from __future__ import annotations

import asyncio
import html
import os
import subprocess
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from bot.callback_data import CB_UPDATE
from bot.common import get_bridge_client, get_config, refresh_instances, reply
from bot.i18n import t
from bot.keyboards import cb_token
from bot.launcher import _owns, launch_agents


def bot_sha() -> str:
    """The commit this bot runs: baked in by CI as POLYDAEMON_SHA (the image has
    no git), else read from the checkout it runs from."""
    sha = os.environ.get("POLYDAEMON_SHA", "").strip()
    if sha:
        return sha[:7]
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=Path(__file__).resolve().parents[2],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def _same(a: str, b: str) -> bool:
    return bool(a and b) and (a.startswith(b) or b.startswith(a))


LOCAL = "local"   # "version" of the machine the bot itself runs on: the bot's commit


def render(ref: str, machines: list[tuple[str, dict | str | None, list[tuple[str, str | None]]]]) -> list[str]:
    """Lines for /versions. `machines` = [(label, agent /version, None when it did
    not answer, or LOCAL; [(window name, its code_sha, None when it did not
    answer)])]; `ref` = the bot's own commit, '' when unknown."""
    lines = [t("versions.bot", sha=html.escape(ref or "?"))]
    for label, ver, windows in machines:
        name = html.escape(label or t("versions.this_machine"))
        if ver == LOCAL:
            lines.append("")
            lines.append(t("versions.machine_local", name=name))
            base = ref
        elif ver and ver.get("ok"):
            sha = str(ver.get("sha") or "")
            mark = "" if not ref else (" ✅" if _same(sha, ref) else " ⚠️")
            lines.append("")
            lines.append(t("versions.machine", name=name, sha=html.escape(sha), branch=html.escape(str(ver.get("branch") or "?"))) + mark)
            dirty = ver.get("dirty")
            if dirty:
                lines.append(t("versions.dirty", files=html.escape(", ".join(dirty[:5])) + (" …" if len(dirty) > 5 else "")))
            hooks = ver.get("hooks_current")
            lines.append(t("versions.hooks_ok") if hooks is True
                         else t("versions.hooks_stale") if hooks is False
                         else t("versions.hooks_unknown"))
            base = sha
        else:
            lines.append("")
            lines.append(t("versions.machine_silent", name=name))
            base = ""       # a restart cannot fix what we cannot see: judge nothing
        # A window that did not answer is not "old", only unknown.
        stale = [(w, s) for w, s in windows if s is not None and not _same(s, base)]
        if not windows:
            lines.append(t("versions.no_windows"))
        elif not base:
            lines.append(t("versions.windows_nobase", count=len(windows)))
        elif not stale:
            lines.append(t("versions.windows_ok", count=len(windows)))
        else:
            items = ", ".join(f"{html.escape(w)} ({html.escape(s) if s else '?'})" for w, s in stale)
            lines.append(t("versions.windows_stale", count=len(stale), total=len(windows), items=items))
    return lines


def _token(context: ContextTypes.DEFAULT_TYPE) -> str:
    return str((get_config(context).get("bot", {}) or {}).get("registry_enroll_token", "")).strip()


def behind(ref: str, labelled: list[tuple[str, dict | None]]) -> list[str]:
    """Labels of the machines whose checkout is readable and not at `ref`."""
    return [label for label, ver in labelled
            if ref and ver and ver.get("ok") and not _same(str(ver.get("sha") or ""), ref)]


def update_keyboard(labels: list[str]) -> InlineKeyboardMarkup | None:
    if not labels:
        return None
    rows = [[InlineKeyboardButton(t("versions.btn_update", name=l or t("versions.this_machine")),
                                  callback_data=f"{CB_UPDATE}:{cb_token(l)}")] for l in labels]
    if len(labels) > 1:
        rows.append([InlineKeyboardButton(t("versions.btn_update_all"), callback_data=f"{CB_UPDATE}:all")])
    return InlineKeyboardMarkup(rows)


def update_result_line(label: str, before: str, res: dict | None, exc: Exception | None) -> str:
    name = html.escape(label)
    if exc is not None:
        return t("versions.upd_unreachable", name=name, error=html.escape(str(exc)))
    if not res or not res.get("ok"):
        steps = (res or {}).get("steps") or []
        bad = next((s for s in steps if not s.get("ok")), None)
        why = f"{bad['step']}: {bad['detail']}" if bad else (res or {}).get("reason", "?")
        return t("versions.upd_failed", name=name, why=html.escape(str(why)[:300]))
    tail = t("versions.upd_restarting") if res.get("restarting") else t("versions.upd_agent_old")
    return t("versions.upd_ok", name=name, before=html.escape(before or "?"),
             after=html.escape(str(res.get("sha_now") or "?"))) + tail


async def update_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data or query.message is None:
        return
    which = query.data.split(":", 1)[1]
    ref = bot_sha()
    if not ref:
        await query.answer(t("versions.upd_no_ref"), show_alert=True)
        return
    await query.answer()
    agents = launch_agents(context)
    client = get_bridge_client(context)
    token = _token(context)
    versions = await asyncio.gather(*(client.get_agent_version(a.url, token) for a in agents))
    todo = behind(ref, [(a.label, v) for a, v in zip(agents, versions)])
    silent = [a.label for a, v in zip(agents, versions) if v is None]
    if which != "all":
        todo = [l for l in todo if cb_token(l) == which]
        silent = [l for l in silent if cb_token(l) == which]
    if not todo:
        # "Nothing to do" only when every machine asked actually answered.
        text = (t("versions.upd_silent", names=html.escape(", ".join(l or t("versions.this_machine") for l in silent)))
                if silent else t("versions.upd_nothing"))
        await query.edit_message_text(text, parse_mode="HTML")
        return
    await query.edit_message_text(
        t("versions.upd_started", names=html.escape(", ".join(l or t("versions.this_machine") for l in todo)), sha=ref),
        parse_mode="HTML")
    chat_id, message_id = query.message.chat_id, query.message.message_id
    before = {a.label: str((v or {}).get("sha") or "") for a, v in zip(agents, versions)}
    by_label = {a.label: a for a in agents}

    async def run() -> None:
        async def one(label: str) -> str:
            try:
                res = await client.post_update(by_label[label].url, token, ref)
                return update_result_line(label, before.get(label, ""), res, None)
            except Exception as exc:
                return update_result_line(label, before.get(label, ""), None, exc)
        lines = await asyncio.gather(*(one(l) for l in todo))
        text = "\n".join([t("versions.upd_done", sha=ref), *lines, "", t("versions.upd_windows_hint")])
        await context.bot.edit_message_text(chat_id=chat_id, message_id=message_id, text=text, parse_mode="HTML")

    context.application.create_task(run())


async def stale_window_keys(context: ContextTypes.DEFAULT_TYPE, instances: list) -> set[str]:
    """Keys of the windows running other code than their machine's checkout (the
    bot's own commit when the machine cannot say) — what `/restart stale` restarts.
    A window too old to report its commit counts as stale: it predates this."""
    client = get_bridge_client(context)
    token = _token(context)
    agents = launch_agents(context)
    versions = await asyncio.gather(*(client.get_agent_version(a.url, token) for a in agents))
    contexts = await asyncio.gather(*(client.get_context(i.key) for i in instances))
    ref = bot_sha()
    out: set[str] = set()
    for inst, info in zip(instances, contexts):
        if info is None:
            continue                                  # not answering: nothing to judge
        base = ref
        for a, v in zip(agents, versions):
            if inst.cwd and _owns(a, inst.cwd):
                # A machine that does not say what it runs: a restart would come
                # back on the same unknown checkout, so leave its windows alone.
                base = str(v.get("sha") or "") if v and v.get("ok") else ""
                break
        if base and not _same(str(info.get("code_sha") or ""), base):
            out.add(inst.key)
    return out


async def versions_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    client = get_bridge_client(context)
    token = _token(context)
    agents = launch_agents(context)
    instances = refresh_instances(context)

    contexts = await asyncio.gather(*(client.get_context(i.key) for i in instances))
    versions = await asyncio.gather(*(client.get_agent_version(a.url, token) for a in agents))

    groups: list = [(a.label, v, []) for a, v in zip(agents, versions)]
    if not groups:
        groups = [("", LOCAL, [])]    # bot and windows on one machine, no agent
    other: list = []
    for inst, info in zip(instances, contexts):
        entry = (inst.display_name, None if info is None else info.get("code_sha", ""))
        owner = next((g for a, g in zip(agents, groups) if inst.cwd and _owns(a, inst.cwd)), None)
        (owner[2] if owner else groups[0][2] if not agents else other).append(entry)
    if other:
        groups.append((t("versions.elsewhere"), LOCAL, other))

    ref = bot_sha()
    kb = update_keyboard(behind(ref, [(a.label, v) for a, v in zip(agents, versions)]))
    await reply(update, context, "\n".join(render(ref, groups)), reply_markup=kb, parse_mode="HTML")


if __name__ == "__main__":  # self-check: PYTHONPATH=tg-bot python3 tg-bot/bot/versions.py
    from bot import i18n as _i18n
    _i18n.configure({"bot": {"locale": "en"}})

    assert _same("b5e6589", "b5e6589a94") and not _same("", "") and not _same("abc", "")
    out = "\n".join(render("b5e6589", [
        ("Mac", {"ok": True, "sha": "b5e6589", "branch": "main", "dirty": [], "hooks_current": True},
         [("api", "b5e6589"), ("web", "7ef4c08"), ("old", "")]),
        ("Windows", {"ok": True, "sha": "7ef4c08", "branch": "main", "dirty": ["launch-ws.ps1"], "hooks_current": False},
         [("infra-win", "7ef4c08")]),
        ("Linux", None, []),
    ]))
    assert "Mac" in out and "b5e6589" in out
    assert "web (7ef4c08)" in out and "old (?)" in out, "old windows are named, unknown ones too"
    assert "api (" not in out, "a window on the machine's code is not listed as stale"
    assert "⚠️" in out, "a machine behind the bot is flagged"
    assert "launch-ws.ps1" in out, "local edits are shown — they block an update"
    assert "install.py" in out, "stale hooks say how to fix them"
    assert "not answering" in out
    # A window is compared with ITS machine's checkout: Windows at 7ef4c08 with a
    # window at 7ef4c08 has nothing to restart — its problem is the checkout.
    assert "infra-win (" not in out
    # No reference commit: nothing is judged stale; a silent window is not "old".
    out2 = "\n".join(render("", [("", LOCAL, [("api", "b5e6589")]), ("Mac", None, [("x", "abc1234")])]))
    assert "older code" not in out2, out2
    out3 = "\n".join(render("b5e6589", [("Mac", {"ok": True, "sha": "b5e6589"}, [("quiet", None), ("ok", "b5e6589")])]))
    assert "quiet" not in out3 and "older code" not in out3, out3

    # Update buttons: only for machines that are readable AND behind.
    vers = [("Mac", {"ok": True, "sha": "b5e6589"}), ("Windows", {"ok": True, "sha": "7ef4c08"}),
            ("Linux", None), ("", {"ok": True, "sha": "0000000"})]
    assert behind("b5e6589", vers) == ["Windows", ""], "silent machines get no button; an unlabelled one does"
    assert behind("", vers) == [], "no reference commit, no update"
    assert update_keyboard([]) is None
    kb = update_keyboard(["Mac", "Windows"])
    assert len(kb.inline_keyboard) == 3, "one per machine plus 'all'"
    assert all(len(b.callback_data.encode()) <= 64 for r in kb.inline_keyboard for b in r)
    ok = update_result_line("Mac", "7ef4c08", {"ok": True, "sha_now": "b5e6589", "restarting": True}, None)
    assert "7ef4c08" in ok and "b5e6589" in ok
    bad = update_result_line("Win", "7ef4c08", {"ok": False, "steps": [
        {"step": "fetch", "ok": True, "detail": ""}, {"step": "merge", "ok": False, "detail": "local changes"}]}, None)
    assert "merge: local changes" in bad, "the failing step and git's words are shown"
    assert "boom" in update_result_line("X", "", None, RuntimeError("boom"))
    print("versions self-check OK")
