from __future__ import annotations

import asyncio
import logging

from telegram import Update
from telegram.ext import ContextTypes

from bot.callback_data import (
    CB_APPROVE,
    CB_ASK,
    CB_LAUNCH,
    CB_PERM,
    CB_PLAN,
    CB_REPLY_TO,
    CB_SETTINGS,
    CB_WINDOW,
    CB_WSTATUS,
)
from bot.common import (
    build_window_options,
    find_instance,
    get_bridge_client,
    get_display_name,
    get_sessions,
    get_storage,
    get_user_id,
    persist_active_instances,
    refresh_instances,
    reply,
)
from bot.i18n import t
from bot.keyboards import (
    build_default_window_keyboard,
    cb_token,
    resolve_cb_token,
    build_permission_confirm_keyboard,
    build_permission_mode_picker,
    build_permissions_keyboard,
    build_settings_root_keyboard,
    build_status_refresh_keyboard,
    build_status_windows_keyboard,
)
from bot.launcher import AGENT_LABELS, build_launch_view, launch_workspace, list_launchable, resolve_agent_label
from bot.permissions import (
    MODE_BYPASS,
    MODE_LABELS,
    mode_help,
    MODES,
    perm_header,
    get_mode_for_workspace,
    list_workspaces_with_modes,
    set_mode_for_workspace,
)
from bot.settings import (
    clear_default_instance_override,
    load_default_instance_override,
    save_default_instance_override,
)
from bridge.protocol import WindowStatus


logger = logging.getLogger(__name__)


def _parse_window_callback_data(data: str) -> str | None:
    prefix, sep, value = data.partition(":")
    return value if prefix == CB_WINDOW and sep and value else None


async def window_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None:
        return

    instance_name = _parse_window_callback_data(query.data or "")
    if instance_name is None:
        await query.answer(t("cb.bad_choice"), show_alert=True)
        return

    runtime_instances = refresh_instances(context)
    # The button carries a cb_token, not the name: a long workspace name pushed
    # callback_data past Telegram's 64-byte cap and the whole keyboard was
    # rejected. resolve_cb_token also accepts a raw name so keyboards sent
    # before this change stay tappable.
    instance_name = resolve_cb_token(instance_name, [i.key for i in runtime_instances]) or instance_name
    if find_instance(runtime_instances, instance_name) is None:
        await query.answer(t("common.window_not_found"), show_alert=True)
        return

    user_id = get_user_id(update)
    session = get_sessions(context).set_active_instance(user_id, instance_name)
    persist_active_instances(context.application)
    logger.info("window switch user_id=%s instance=%s", user_id, instance_name)

    # The switch itself is just a pointer update. The visible slowness used to
    # come from re-pinging every instance to redraw the picker — mirror the
    # /reply-here UX instead: drop the keyboard, confirm immediately.
    active_label = get_display_name(context, session.active_instance)
    await query.answer(t("cb.active_window_toast", display=active_label))
    try:
        await query.edit_message_text(
            text=t("cb.active_window", display=active_label),
            parse_mode="HTML",
        )
    except Exception:
        pass


async def reply_to_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":", 1)
    if len(parts) != 2 or parts[0] != CB_REPLY_TO:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    instance_key = parts[1]

    runtime_instances = refresh_instances(context)
    if find_instance(runtime_instances, instance_key) is None:
        await query.answer(t("cb.window_gone"), show_alert=True)
        return

    user_id = get_user_id(update)
    get_sessions(context).set_active_instance(user_id, instance_key)
    persist_active_instances(context.application)
    display = get_display_name(context, instance_key)
    logger.info("window switch via reply-here user_id=%s instance=%s", user_id, instance_key)
    await query.answer(t("cb.active_window_toast", display=display))
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    # Mirror /window and the persistent reply keyboard: tell the user explicitly
    # that the active window changed.
    await reply(update, context, t("cb.active_window", display=display), parse_mode="HTML")


async def approve_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":")
    if len(parts) != 3 or parts[0] != CB_APPROVE:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    _, approval_id, action = parts
    if action not in {"once", "always", "deny"}:
        await query.answer(t("common.unknown_action"), show_alert=True)
        return

    logger.info("approval button received query=%s id=%s action=%s user=%s chat=%s message=%s",
                query.id, approval_id, action, update.effective_user.id if update.effective_user else None,
                update.effective_chat.id if update.effective_chat else None,
                query.message.message_id if query.message else None)

    runtime_instances = refresh_instances(context)
    bridge_client = get_bridge_client(context)

    # Owner-first: the message the buttons sit on carries a per-message route to
    # the window that asked, so POST straight to it (the same fast path as ask).
    delivered = False
    owner_key = _owning_instance_for_message(update, context, runtime_instances)
    if owner_key is not None:
        if await bridge_client.post_approve_callback(owner_key, approval_id, action):
            delivered = True

    # Fallback: probe every other live instance CONCURRENTLY so one unreachable
    # window can't serialize behind the others (approval_ids are unique per
    # process, so only the owner acts; the rest no-op). First success wins.
    if not delivered:
        candidates = [i for i in runtime_instances if i.key != owner_key]
        results = await asyncio.gather(
            *(bridge_client.post_approve_callback(inst.key, approval_id, action) for inst in candidates),
            return_exceptions=True,
        )
        if any(ok is True for ok in results):
            delivered = True

    if delivered:
        toast = {"once": t("cb.approve_once"), "always": t("cb.approve_always"), "deny": t("cb.approve_deny")}[action]
    else:
        toast = t("cb.request_expired")

    logger.info("approval callback id=%s action=%s user=%s chat=%s message=%s owner=%s delivered=%s",
                approval_id, action, update.effective_user.id if update.effective_user else None,
                update.effective_chat.id if update.effective_chat else None,
                query.message.message_id if query.message else None, owner_key, delivered)

    await query.answer(toast)
    try:
        # text_html reconstructs the HTML formatting from stored entities so the
        # pretty <b>/<pre> blocks survive editing. Plain .text strips formatting.
        original_html = ""
        if query.message:
            original_html = getattr(query.message, "text_html", None) or query.message.text or ""
        suffix = f"\n\n→ {toast}"
        new_text = original_html + suffix if not original_html.endswith(suffix) else original_html
        await query.edit_message_text(text=new_text, reply_markup=None, parse_mode="HTML")
    except Exception:
        pass


async def plan_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Deliver an ExitPlanMode decision (apply/decline) back to the plugin.

    Wire format: ``plan:<id>:<apply|decline>``.
    """
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":")
    if len(parts) != 3 or parts[0] != CB_PLAN:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    _, plan_id, action = parts
    if action not in {"apply", "decline"}:
        await query.answer(t("common.unknown_action"), show_alert=True)
        return

    runtime_instances = refresh_instances(context)
    bridge_client = get_bridge_client(context)

    # Owner-first then concurrent fallback (see approve_callback for the rationale).
    delivered = False
    owner_key = _owning_instance_for_message(update, context, runtime_instances)
    if owner_key is not None:
        if await bridge_client.post_plan_callback(owner_key, plan_id, action):
            delivered = True

    if not delivered:
        candidates = [i for i in runtime_instances if i.key != owner_key]
        results = await asyncio.gather(
            *(bridge_client.post_plan_callback(inst.key, plan_id, action) for inst in candidates),
            return_exceptions=True,
        )
        if any(ok is True for ok in results):
            delivered = True

    if delivered:
        toast = t("cb.plan_accepted") if action == "apply" else t("cb.plan_declined")
    else:
        toast = t("cb.request_expired")
    await query.answer(toast)

    try:
        original_html = ""
        if query.message:
            original_html = getattr(query.message, "text_html", None) or query.message.text or ""
        suffix = f"\n\n→ {toast}"
        new_text = original_html + suffix if not original_html.endswith(suffix) else original_html
        await query.edit_message_text(text=new_text, reply_markup=None, parse_mode="HTML")
    except Exception:
        pass


def _owning_instance_for_message(
    update: Update, context: ContextTypes.DEFAULT_TYPE, instances: list
) -> str | None:
    """Which plugin owns the message the buttons sit on (ask / approval / plan).

    Primary signal: the per-message route the plugin recorded when it sent the
    prompt (`recordMessageRoute`). That route exists whether the prompt landed in
    the DM or in the window's forum topic, so a single lookup covers both — same
    mechanism a native reply on the message uses.
    Secondary: the topic thread binding, in case the route row is missing."""
    msg = update.callback_query.message if update.callback_query else None
    if msg is None:
        return None
    storage = get_storage(context)
    routed = storage.lookup_route(msg.chat_id, msg.message_id)
    if routed and find_instance(instances, routed) is not None:
        return routed
    if msg.message_thread_id is not None:
        workspace_id = storage.get_workspace_by_thread(msg.chat_id, msg.message_thread_id)
        if workspace_id:
            from bot.topics import resolve_workspace_id
            inst = next((i for i in instances if resolve_workspace_id(i) == workspace_id), None)
            if inst is not None:
                return inst.key
    return None


async def ask_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Deliver an AskUserQuestion inline-button tap to the plugin.

    Wire formats (mirror channel-plugin/server.ts):
      - ``ask:<id>:<idx>``        single-select pick
      - ``ask:<id>:t:<idx>``      multiSelect toggle
      - ``ask:<id>:d``            multiSelect commit
      - ``ask:<id>:c``            user requested free-text reply
    """
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":")
    if len(parts) < 3 or parts[0] != CB_ASK:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    ask_id = parts[1]
    rest = parts[2:]

    # Decode the action shape — the third token disambiguates.
    action: str | None
    option_idx: int | None
    if len(rest) == 1 and rest[0] == "d":
        action, option_idx = "done", None
    elif len(rest) == 1 and rest[0] == "c":
        action, option_idx = "custom", None
    elif len(rest) == 2 and rest[0] == "t":
        try:
            option_idx = int(rest[1])
        except ValueError:
            await query.answer(t("cb.bad_option_index"), show_alert=True)
            return
        action = "toggle"
    elif len(rest) == 1:
        # Bare numeric idx — legacy single-select shape.
        try:
            option_idx = int(rest[0])
        except ValueError:
            await query.answer(t("common.bad_callback"), show_alert=True)
            return
        if option_idx < 0:
            await query.answer(t("cb.bad_option_index"), show_alert=True)
            return
        action = None
    else:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return

    runtime_instances = refresh_instances(context)
    bridge_client = get_bridge_client(context)

    delivered_instance: str | None = None

    # Fast path: the message the buttons sit on already carries a per-message
    # route to the window that asked (recorded when the question was sent),
    # exactly like a native reply. POST straight to that window. The old code
    # instead tried every instance in SEQUENCE, and a single unreachable/slow
    # window ahead of the right one stalled the answer for up to post_timeout
    # (10s) per instance — the ~10s delay seen answering in a topic.
    owner_key = _owning_instance_for_message(update, context, runtime_instances)
    if owner_key is not None:
        if await bridge_client.post_ask_action(
            owner_key, ask_id, action=action, option_idx=option_idx,
        ):
            delivered_instance = owner_key

    # Fallback (DM-origin ask, or an unbound thread): probe every live instance
    # CONCURRENTLY so one unreachable window can't serialize behind the others.
    # ask_ids are unique per plugin process, so only the owner acts; the rest
    # no-op. First success wins.
    if delivered_instance is None:
        candidates = [i for i in runtime_instances if i.key != owner_key]
        results = await asyncio.gather(
            *(
                bridge_client.post_ask_action(
                    inst.key, ask_id, action=action, option_idx=option_idx,
                )
                for inst in candidates
            ),
            return_exceptions=True,
        )
        for inst, ok in zip(candidates, results, strict=False):
            if ok is True:
                delivered_instance = inst.key
                break

    if delivered_instance is None:
        await query.answer(t("cb.ask_expired"))
        return

    # Custom-answer request: remember which plugin owns this ask so the next
    # text reply from this user gets routed to /ask-callback as the answer
    # rather than as a normal chat message.
    if action == "custom":
        user_id = get_user_id(update)
        get_sessions(context).set_pending_custom_ask(user_id, ask_id, delivered_instance)
        await query.answer(t("cb.ask_awaiting_text"))
        return

    # Toggles don't terminate the question — the plugin re-renders the
    # keyboard via editMessageReplyMarkup; just acknowledge.
    if action == "toggle":
        await query.answer("☑️")
        return

    if action == "done":
        await query.answer(t("cb.ask_done"))
    else:
        await query.answer(t("cb.ask_answer_sent"))


async def window_status_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":", 2)
    if not parts or parts[0] != CB_WSTATUS:
        return
    action = parts[1] if len(parts) > 1 else ""

    if action == "list":
        runtime_instances = refresh_instances(context)
        if not runtime_instances:
            await query.answer(t("common.no_windows"), show_alert=True)
            return
        user_id = get_user_id(update)
        session = get_sessions(context).get(user_id)
        options = await build_window_options(context, session.active_instance)
        await query.answer()
        try:
            await query.edit_message_text(
                t("cmd.pick_window"),
                reply_markup=build_status_windows_keyboard(options),
            )
        except Exception:
            pass
        return

    if action == "show" and len(parts) >= 3:
        runtime_instances = refresh_instances(context)
        instance_key = resolve_cb_token(parts[2], [i.key for i in runtime_instances]) or parts[2]
        instance = find_instance(runtime_instances, instance_key)
        if instance is None:
            await query.answer(t("cb.window_gone"), show_alert=True)
            return

        bridge_client = get_bridge_client(context)
        status = await bridge_client.get_status(instance_key, timeout=2.0)
        await query.answer()

        user_id = get_user_id(update)
        active_key = get_sessions(context).get(user_id).active_instance
        text = _render_window_status(instance.display_name, status, is_active=(instance_key == active_key))
        try:
            await query.edit_message_text(
                text,
                parse_mode="HTML",
                reply_markup=build_status_refresh_keyboard(instance_key),
                disable_web_page_preview=True,
            )
        except Exception:
            # Edits routinely fail when content is unchanged ("message is not modified") —
            # not worth surfacing; the toast already confirmed the tap.
            pass
        return

    await query.answer(t("common.unknown_action"), show_alert=True)


def _render_window_status(display_name: str, status: WindowStatus | None, *, is_active: bool) -> str:
    import html
    import time
    name_html = html.escape(display_name)
    active_marker = " ✅" if is_active else ""
    header = f"🪟 <b>{name_html}</b>{active_marker}"

    if status is None:
        return f"{header}\n{t('cb.status_offline')}"

    if status.is_working:
        if status.last_edit_ts is not None:
            # last_edit_ts is ms epoch from the plugin (JS Date.now()).
            delta_s = max(0.0, time.time() - status.last_edit_ts / 1000.0)
            state_line = t("cb.status_working_since", age=_format_age(delta_s))
        else:
            state_line = t("cb.status_working")
    else:
        state_line = t("cb.status_idle")

    lines = [header, state_line]

    # recent_events already includes per-turn tool calls; progress_lines is a
    # legacy subset returned by older plugin builds. Prefer recent_events when
    # the plugin provides them.
    activity = status.recent_events or status.progress_lines
    if activity:
        lines.append("")
        for line in activity[-12:]:
            lines.append(f"• {html.escape(line)}")
    return "\n".join(lines)


def _format_age(seconds: float) -> str:
    if seconds < 60:
        return t("common.age_seconds", n=int(seconds))
    if seconds < 3600:
        return t("common.age_minutes", n=int(seconds // 60))
    return t("common.age_hours", n=int(seconds // 3600))


async def launch_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":", 2)
    if not parts or parts[0] != CB_LAUNCH:
        return
    action = parts[1] if len(parts) > 1 else ""

    if action == "view" and len(parts) == 3:
        fields = parts[2].split(":")
        if len(fields) != 3 or fields[0] not in AGENT_LABELS or fields[1] not in ("0", "1"):
            await query.answer(t("cb.launch_already_running"), show_alert=True)
            return
        kind, mode, machine = fields
        label = resolve_agent_label(context, machine)
        text, keyboard = build_launch_view(context, label, kind, mode == "1")
        await query.answer()
        try:
            await query.edit_message_text(text, reply_markup=keyboard)
        except Exception:
            pass
        return

    if action in ("list", "tab"):
        # "tab" carries which machine; "list" is the plain refresh from a
        # single-machine keyboard. Same view builder either way, so the tab row
        # and the empty-state wording cannot drift between them.
        label = resolve_agent_label(context, parts[2]) if action == "tab" and len(parts) >= 3 else ""
        text, keyboard = build_launch_view(context, label)
        await query.answer()
        try:
            await query.edit_message_text(text, reply_markup=keyboard)
        except Exception:
            pass
        return

    if action == "go" and len(parts) >= 3:
        payload = parts[2]
        kind, new_session = "claude", False
        fields = payload.split(":")
        modern = len(fields) == 3
        if modern:
            kind, mode, payload = fields
            if kind not in AGENT_LABELS or mode not in ("0", "1"):
                await query.answer(t("cb.launch_already_running"), show_alert=True)
                return
            new_session = mode == "1"
        # Re-verify against the CURRENT launchable set — the keyboard may be
        # stale (window started meanwhile, folder renamed, …). Prevents
        # double-launching an already-live workspace. Resolving the token here
        # doubles as that check: no match ⇒ not launchable any more.
        workspaces = list_launchable(context, kind=kind)
        matches = [(title, cwd) for title, cwd in workspaces
                   if (cb_token(cwd) == payload if modern else payload in (cb_token(title), title))]
        hit = matches[0] if len(matches) == 1 else None
        if hit is None:
            await query.answer(t("cb.launch_already_running"), show_alert=True)
            return
        # The cwd travels with the name: it is what picks the MACHINE, and two
        # machines can hold a folder of the same name.
        name, cwd = hit
        try:
            await launch_workspace(context, name, cwd, kind, new_session)
        except Exception as exc:
            logger.exception("launch failed for %r", name)
            await query.answer(t("cb.launch_failed", error=exc), show_alert=True)
            return
        name = f"{name} · {AGENT_LABELS[kind]}"
        await query.answer(t("cb.launch_starting_toast", name=name))
        try:
            await query.edit_message_text(
                t("cb.launch_starting", name=name),
                parse_mode="HTML",
            )
        except Exception:
            pass
        return


async def settings_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":", 2)
    if not parts or parts[0] != CB_SETTINGS:
        return
    action = parts[1] if len(parts) > 1 else ""

    if action == "root":
        await query.answer()
        try:
            await query.edit_message_text(
                t("cb.settings_title"),
                parse_mode="HTML",
                reply_markup=build_settings_root_keyboard(),
            )
        except Exception:
            pass
        return

    if action == "perm":
        items = list_workspaces_with_modes(context)
        await query.answer()
        try:
            await query.edit_message_text(
                perm_header(),
                parse_mode="HTML",
                reply_markup=build_permissions_keyboard(items, MODE_LABELS),
            )
        except Exception:
            pass
        return

    if action == "defwin":
        await _render_default_window_picker(update, context)
        return

    if action == "setdef" and len(parts) >= 3:
        runtime_instances = refresh_instances(context)
        instance_key = resolve_cb_token(parts[2], [i.key for i in runtime_instances]) or parts[2]
        if find_instance(runtime_instances, instance_key) is None:
            await query.answer(t("cb.window_gone"), show_alert=True)
            return
        try:
            save_default_instance_override(instance_key)
        except Exception:
            logger.exception("failed to persist default-instance override")
            await query.answer(t("cb.save_failed"), show_alert=True)
            return
        await query.answer(t("cb.default_window_set", display=get_display_name(context, instance_key)))
        await _render_default_window_picker(update, context)
        return

    if action == "cleardef":
        try:
            clear_default_instance_override()
        except Exception:
            logger.exception("failed to clear default-instance override")
            await query.answer(t("cb.save_failed"), show_alert=True)
            return
        await query.answer(t("cb.override_cleared"))
        await _render_default_window_picker(update, context)
        return

    await query.answer(t("common.unknown_action"), show_alert=True)


async def _render_default_window_picker(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None:
        return
    user_id = get_user_id(update)
    session = get_sessions(context).get(user_id)
    options = await build_window_options(context, session.active_instance)
    current_default = load_default_instance_override()
    body_lines = [
        t("cb.default_window_title"),
        "",
        t("cb.default_window_hint"),
    ]
    if current_default is None:
        body_lines.append("\n" + t("cb.default_window_no_override"))
    try:
        await query.edit_message_text(
            "\n".join(body_lines),
            parse_mode="HTML",
            reply_markup=build_default_window_keyboard(options, current_default),
        )
    except Exception:
        pass


def _perm_workspace(context: ContextTypes.DEFAULT_TYPE, payload: str) -> str:
    """Workspace name behind a `perm:*` callback payload.

    The buttons carry a cb_token because a long workspace name pushed
    callback_data over Telegram's 64-byte cap, which rejects the ENTIRE keyboard
    — measured live 2026-09-15 at 67..88 bytes for these very buttons. Candidates
    are the same list the keyboard was built from, so a workspace that has an
    override but no live window still resolves. Unknown payloads are returned
    unchanged: a keyboard sent before this change carries the raw name, and the
    caller already handles a name that no longer exists.
    """
    try:
        names = [ws for ws, _mode in list_workspaces_with_modes(context)]
    except Exception:
        return payload
    return resolve_cb_token(payload, names) or payload


async def permissions_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return

    parts = query.data.split(":")
    if not parts or parts[0] != CB_PERM:
        return
    action = parts[1] if len(parts) > 1 else ""

    if action == "list":
        items = list_workspaces_with_modes(context)
        await query.answer()
        try:
            await query.edit_message_text(
                perm_header(),
                parse_mode="HTML",
                reply_markup=build_permissions_keyboard(items, MODE_LABELS),
            )
        except Exception:
            pass
        return

    if action == "pick" and len(parts) >= 3:
        workspace = _perm_workspace(context, ":".join(parts[2:]))
        current = get_mode_for_workspace(workspace)
        await query.answer()
        try:
            await query.edit_message_text(
                t("cb.perm_current_mode", workspace=workspace, mode=MODE_LABELS[current], hint=mode_help(current)),
                parse_mode="HTML",
                reply_markup=build_permission_mode_picker(workspace, current, MODES, MODE_LABELS, MODE_BYPASS),
            )
        except Exception:
            pass
        return

    if action == "confirm" and len(parts) >= 4:
        workspace = _perm_workspace(context, ":".join(parts[2:-1]))
        await query.answer()
        try:
            await query.edit_message_text(
                t("cb.perm_bypass_confirm", workspace=workspace),
                parse_mode="HTML",
                reply_markup=build_permission_confirm_keyboard(workspace, MODE_BYPASS),
            )
        except Exception:
            pass
        return

    if action == "set" and len(parts) >= 4:
        mode = parts[-1]
        workspace = _perm_workspace(context, ":".join(parts[2:-1]))
        if mode not in MODES:
            await query.answer(t("cb.unknown_mode"), show_alert=True)
            return
        try:
            set_mode_for_workspace(workspace, mode)
        except Exception:
            logger.exception("failed to save permission mode")
            await query.answer(t("cb.save_failed"), show_alert=True)
            return
        await query.answer(MODE_LABELS[mode])
        items = list_workspaces_with_modes(context)
        try:
            await query.edit_message_text(
                perm_header(),
                parse_mode="HTML",
                reply_markup=build_permissions_keyboard(items, MODE_LABELS),
            )
        except Exception:
            pass
        return

    await query.answer(t("common.unknown_action"), show_alert=True)
