# English UI strings — the canonical key list. A key that exists here must exist
# in every other locale; bot/i18n.py::check_tables enforces that, and also that
# the {placeholders} match across locales.
#
# Templates are str.format style. Do NOT use f-strings here: an f-string is
# interpolated where it is written, which defeats the whole point.
#
# Grouped by the module that says them. A key starting with "common." is said by
# more than one module — identical text gets exactly ONE key, because the same
# sentence under two keys is how two languages drift apart.

STRINGS: dict[str, str] = {
    # --- Reply keyboard ------------------------------------------------------------
    "kb.back": "◀️ Back",
    "kb.back_to_list": "◀️ Back to list",
    "kb.back_to_settings": "◀️ Back to settings",
    "kb.clear_default_override": "🗑 Clear override (use config.yaml)",
    "kb.confirm_bypass": "🔓 Yes, enable Bypass",
    "kb.default_window": "🪟 Default window",
    "kb.launch": "🚀 Launch",
    "kb.perm_by_workspace": "🔐 Permissions per workspace",
    "kb.placeholder_main": "Type a message or pick a window via {windows}",
    "kb.placeholder_quick_switch": "Tap a window to switch, {status} or {back}",
    "kb.refresh": "🔄 Refresh",
    "kb.save": "💾 Save it",
    "kb.settings": "⚙️ Settings",
    "kb.status": "📈 Status",
    "kb.windows": "📊 Windows",

    # --- Shared replies ------------------------------------------------------------
    "common.age_hours": "{n}h",
    "common.age_minutes": "{n}m",
    "common.age_seconds": "{n}s",
    "common.bad_callback": "⚠️ Invalid callback.",
    "common.failed_reason": "❌ Failed: {reason}",
    "common.launch_all_running": "✅ Every registered workspace is already running (or has no tg-claude launcher).",
    "common.no_windows": "🚫 No Claude Code windows registered.",
    "common.no_windows_available": "🚫 No Claude Code windows available.",
    "common.unknown_action": "⚠️ Unknown action.",
    "common.window_not_found": "🚫 Window not found.",
    "common.window_unavailable": "window unavailable",

    # --- Commands ------------------------------------------------------------------
    "cmd.clear_sent": "🧹 Context-reset signal sent to Claude Code.",
    "cmd.compact_failed": "❌ Could not send /compact to <b>{display}</b>: {reason}",
    "cmd.compact_sent": "🗜 <b>{display}</b>: sent <code>/compact</code> — the window will compact its context and carry on.",
    "cmd.context_model": "model: <code>{model}</code>",
    "cmd.context_percent": "≈ {pct_1m}% of 1M · ≈ {pct_200k}% of 200k",
    "cmd.context_unavailable": "🚫 Could not get the context from <b>{display}</b> — an old plugin without /context, or the transcript has no token data yet.",
    "cmd.context_used": "🧮 <b>{display}</b>: ~{used}k tokens in context",
    "cmd.desc_clear": "🧹 reset context",
    "cmd.desc_compact": "🗜 compact the window's context (/compact)",
    "cmd.desc_context": "🧮 window context usage",
    "cmd.desc_effort": "🧠 effort level",
    "cmd.desc_exit": "🚪 close the window (/exit in claude)",
    "cmd.desc_help": "❓ command list",
    "cmd.desc_launch": "🚀 launch a workspace",
    "cmd.desc_model": "🧠 window model (1M / Sonnet 5 / …)",
    "cmd.desc_restart": "🔄 restart the window (/exit + /launch)",
    "cmd.desc_settings": "⚙️ settings",
    "cmd.desc_start": "👋 greeting",
    "cmd.desc_status": "📊 window status",
    "cmd.desc_tasks": "📋 what's open between windows",
    "cmd.desc_window": "🪟 pick the active window",
    "cmd.error": "❌ Error: {error}",
    "cmd.help": "👋 /start — greeting\n❓ /help — command list\n🧹 /clear — reset the Claude Code context (soft: \"forget the history\")\n🗜 /compact — compact the window's context (the real /compact; cures \"Prompt is too long\")\n📊 /status — status of the registered windows\n👥 /who — who else is in this folder and what they are editing\n🪟 /window — pick the active Claude Code window\n🚀 /launch — launch a workspace that is not running\n🧠 /effort — effort level of the active window (low/medium/high/xhigh/max/ultracode)\n🧠 /model — switch the window's model (buttons Opus 4.8 1M / Sonnet 5 / Fable 5; or /model opus[1m])\n🧮 /context — how much context the window is using (estimated from the transcript)\n🚪 /exit — close the window (runs /exit in claude; the session comes back via /launch)\n🔄 /restart — restart the window (/exit + /launch; resumes the session, handy for updating the plugin)\n🔄 /restart all — restart every idle window (to roll out an update)\n🔄 /restart stale — restart only the idle windows still on older code\n🏷 /versions — which code each machine and window runs, and whose hooks are stale\n⚙️ /settings — settings (permissions, default window)",
    "cmd.pick_window": "📊 Pick a window — I'll show what it is busy with:",
    "cmd.start_greeting": "👋 Hi. Send a message and it goes to the active Claude Code window.",
    "cmd.tasks_header": "📋 <b>Open between windows: {count}</b>",
    "cmd.tasks_legend": "⏳ — waiting for an answer · ⛔ — blocked, needs a decision",
    "cmd.tasks_none": "✅ Nothing open between windows.",
    "cmd.tasks_verb_asked": "asked",

    # --- Incoming messages ---------------------------------------------------------
    "msg.active_window": "🪟 Active window: {name}",
    "msg.active_window_switched": "✅ Active window: {name}",
    "msg.answer_delivered": "✅ Answer delivered to Claude.",
    "msg.ask_expired": "⏱️ Claude's question already closed — forwarding it as a normal message.",
    "msg.attachment_unrecognized": "❌ Could not recognize the attachment.",
    "msg.auth_error": "🔒 Authorization error: {error}",
    "msg.image_failed": "❌ Could not process the image.",
    "msg.mirror_attachment": "<i>📎 attachment</i>",
    "msg.mirror_image": "<i>🖼 image</i>",
    "msg.no_active_window": "🪟 No active window",
    "msg.pick_window": "📊 Pick a window — I'll switch right away:",
    # NOTE: save_broadcast repeats the kb.save label as literal text. Reword the
    # button and this line lies. Left inline deliberately — threading the label
    # through the call site costs more than the coupling is worth here.
    "msg.save_broadcast": "💾 “Save it” — sent to {sent} of {total} windows.",
    "msg.save_failed": "⚠️ Could not reach: {names}",
    "msg.save_reports_dm": "Reports will land here in this DM: {names}",
    "msg.save_reports_topics": "Reports will land in their topics: {names}",
    "msg.status_pick_window": "📈 Tap a window — I'll show what it's working on:",
    "msg.window_gone": "🚫 Window “{name}” is no longer registered.",
    "msg.window_not_running": "🚫 Window '{name}' is not running.",

    # --- Inline buttons and callbacks ----------------------------------------------
    "cb.active_window": "✅ Active window: <b>{display}</b>.",
    "cb.active_window_toast": "✅ Active window: {display}",
    "cb.approve_always": "🔁 Always allowed",
    "cb.approve_deny": "❌ Denied",
    "cb.approve_once": "✅ Allowed",
    "cb.ask_answer_sent": "✅ Answer sent",
    "cb.ask_awaiting_text": "✍️ Waiting for a text answer",
    "cb.ask_done": "✅ Done",
    "cb.ask_expired": "⏱️ Question expired or already answered",
    "cb.bad_choice": "⚠️ Invalid choice.",
    "cb.bad_option_index": "⚠️ Invalid option index.",
    "cb.default_window_hint": "This window becomes active on <code>/start</code> and when the current one closes.",
    "cb.default_window_no_override": "<i>No override set — the value from config.yaml is used.</i>",
    "cb.default_window_set": "✅ Default: {display}",
    "cb.default_window_title": "🪟 <b>Default window</b>",
    "cb.launch_already_running": "Already running (or unavailable).",
    "cb.launch_failed": "❌ Launch failed: {error}",
    "cb.launch_none_here": "✅ Everything on {machine} is already running (or has no launcher).",
    "cb.launch_pick": "🚀 Which workspace should I launch?",
    "cb.launch_starting": "🚀 Launching <b>{name}</b> — the window takes ~15s to come up, a «🟢 Window appeared» announcement will arrive and the topic will come alive.",
    "cb.launch_starting_toast": "🚀 Launching {name}…",
    "cb.override_cleared": "✅ Override cleared",
    "cb.perm_bypass_confirm": "⚠️ Enable <b>Bypass permissions</b> for <b>{workspace}</b>?\n\nClaude will perform any action in this workspace WITHOUT asking for permission.",
    "cb.perm_current_mode": "🔐 <b>{workspace}</b>\nCurrent mode: {mode}\n\n<i>{hint}</i>",
    "cb.plan_accepted": "✅ Plan accepted",
    "cb.plan_declined": "❌ Plan declined",
    "cb.request_expired": "⏱️ Request expired or already approved",
    "cb.save_failed": "❌ Save failed.",
    "cb.settings_title": "⚙️ <b>Settings</b>",
    "cb.status_idle": "💤 Idle (waiting for messages)",
    "cb.status_offline": "🔴 Not responding — the window may be closed.",
    "cb.status_working": "⚡ Working",
    "cb.status_working_since": "⚡ Working · updated {age} ago",
    "cb.unknown_mode": "⚠️ Unknown mode.",
    "cb.window_gone": "🚫 Window is no longer registered.",

    # --- Exit and restart ----------------------------------------------------------
    "exit.btn_cancel": "◀️ Cancel",
    "exit.btn_confirm": "🚪 Yes, exit",
    "exit.btn_restart_all": "🔄 Restart {count}",
    "exit.restart_all_confirm": "🔄 Restart <b>{count}</b> idle window(s)? Each closes (<code>/exit</code>) and comes back with its session resumed.\n{names}{skipped}",
    "exit.restart_all_none": "🔄 Nothing to restart: no window is idle right now.{skipped}",
    "exit.restart_all_skip_busy": "\n⏭ Working — left alone: {names}",
    "exit.restart_all_skip_unknown": "\n❔ Not answering whether it is busy — left alone (use /restart on each): {names}",
    "exit.restart_all_started": "🔄 Restarting idle windows one by one…",
    "exit.restart_all_progress": "🔄 {i}/{n}: {name}…",
    "exit.restart_all_failed": "\n❌ Could not restart: {items}",
    "exit.restart_all_done": "🔄 Done. Restarted: {done}{failed}{skipped}",
    "exit.btn_restart_confirm": "🔄 Yes, restart",
    "exit.restart_cancelled": "🔄 Restart cancelled.",
    "exit.cancelled": "🚪 Exit cancelled.",
    "exit.cancelled_toast": "Cancelled",
    "exit.closing": "🚪 Window <b>{display}</b> is closing (<code>/exit</code>). Bring it back with /launch.",
    "exit.confirm": "🚪 Close window <b>{display}</b>? Claude will run <code>/exit</code> (you can bring the session back with /launch).",
    "exit.restart_close_failed": "❌ Could not close it: {reason}. If the plugin is old (no /inject) — restart the window manually once.",
    "exit.restart_confirm": "🔄 Restart window <b>{display}</b>? The current session will close (<code>/exit</code>) and come up again (resumed via --continue).",
    "exit.restart_done": "🔄 <b>{display}</b> restarted — the window comes up in ~15s, you'll get “🟢 Window appeared”.",
    "exit.restart_not_closed": "⚠️ <b>{display}</b> did not close — /exit was sent, but the window is still running, so it was not started a second time. Check it, then /restart again.",
    "exit.restart_stale_none": "✅ Every window already runs its machine's current code.",
    "exit.still_open": "did not close",
    "exit.restart_launch_failed": "⚠️ <b>{display}</b> closed, but launching it again failed: {error}\nBring it up manually — /launch.",
    "exit.restart_pending": "🔄 <b>{display}</b>: <code>/exit</code> sent, waiting for it to close, then bringing it back up…",
    "exit.restart_toast": "🔄 {display}: closing it and bringing it back up…",
    "exit.sent_toast": "🚪 {display}: /exit sent",

    # --- Permission modes ----------------------------------------------------------
    "perm.header": "🔐 <b>Permissions per workspace</b>\n\n🤔 <b>Ask</b> — ask via Telegram/VSCode\n⚡ <b>Edit automatically</b> — auto Edit/Write, ask only for dangerous things\n📋 <b>Plan</b> — plan only, no execution\n🪄 <b>Auto</b> — Claude picks the mode itself\n🔓 <b>Bypass</b> — never ask\n\n<i>Only Bypass is enforced live — the rest are stored as a preference, set the mode you want in that session's Claude Code UI.</i>",
    "perm.help_accept_edits": "Auto-allows Edit/Write — asks only for Bash and anything dangerous",
    "perm.help_auto": "Claude picks the mode to fit the task",
    "perm.help_bypass": "Never asks — runs everything",
    "perm.help_default": "Asks via Telegram/VSCode before acting",
    "perm.help_plan": "Plan only, no execution",

    # --- Model switching -----------------------------------------------------------
    "model.bad_alias": "⚠️ Invalid model alias.",
    "model.bad_alias_short": "⚠️ Invalid alias.",
    "model.pick_prompt": "🧠 Model for <b>{display}</b>:",
    "model.sent": "🧠 <b>{display}</b>: sent <code>/model {alias}</code>.",
    "model.switch_failed": "❌ Could not switch the model for <b>{display}</b>: {reason}",

    # --- Reasoning effort ----------------------------------------------------------
    "effort.pick_level": "🧠 Effort level for <b>{display}</b>:",
    "effort.unknown_level": "⚠️ Unknown effort level.",

    # --- Cross-window messaging ----------------------------------------------------
    "iw.topic_incoming_ask": "📥 <b>{name}</b> asks:",
    "iw.topic_incoming_tell": "📥 <b>{name}</b> writes:",
    "iw.topic_outgoing_ask": "❓ asked <b>{name}</b>:",
    "iw.topic_outgoing_tell": "📤 → <b>{name}</b>:",

    # --- Registry and disk watch ---------------------------------------------------
    "watch.active_window": "➡️ Active window: {display}",
    "watch.bot_started": "🤖 Bot started. Open Claude Code windows:",
    "watch.low_disk": "⚠️ <b>Low disk space on the bot server</b>\nHost: <code>{host}</code>\nChecked path: <code>{path}</code>\nFree: <b>{free_gb:.1f} GiB</b> of {total_gb:.1f} GiB (threshold {threshold_gb:.0f} GiB).\n\nThe bot may stop writing its database and logs. Free up space on this server; workspace disks are not checked here.",
    "watch.window_appeared": "🟢 Window appeared: {display}",
    "watch.window_disconnected": "🔴 Window disconnected: {display}",

    # --- Provider status watch -----------------------------------------------------
    "status.incident": "{emoji} <b>{name}</b> — {desc}\n<i>{indicator}</i>\n{page}",
    "status.incident_ongoing": "{emoji} <b>{name}</b> — incident already in progress: {desc}\n<i>{indicator}</i>\n{page}",
    "status.recovered": "✅ <b>{name}</b> — back to normal.\n{page}",

    # --- Idle compaction -----------------------------------------------------------
    "compact.gave_up": "🗜 Automatic compaction does not help this window: still ~{tokens}k tokens after a /compact, so I have stopped trying. Claude refuses when there are too few turns to merge, however large they are.",
    "compact.note_sent": "🗜 Sent an automatic context compaction: ~{tokens}k tokens, window silent for {hours:.1f}h.",

    # --- Slash-command injection ---------------------------------------------------
    "inject.local_window_no_pid": "local window without a PID",
    "inject.reason_window_not_found": "window not found",

    # --- Access gate ---------------------------------------------------------------
    "gate.access_denied": "🚫 Access denied. Your Telegram user id is {user_id} — add it to telegram.allowed_users in the bot config to get in.",

    # --- Forum topics --------------------------------------------------------------
    "topics.shared_title": "Agents",

    # --- Who is in this tree ---------------------------------------------------------
    "versions.machine_local": "🖥 <b>{name}</b> (the bot's own machine)",
    "versions.windows_nobase": "   🪟 {count} window(s) — nothing to compare them with",
    "versions.upd_silent": "❌ {names}: agent not answering (busy with an update, restarting, or down) — try /versions again in a minute.",
    "versions.btn_update": "⬆️ Update {name}",
    "versions.btn_update_all": "⬆️ Update all that are behind",
    "versions.upd_no_ref": "The bot does not know its own commit, so there is nothing to update to.",
    "versions.upd_nothing": "✅ Every machine is already at the bot's commit.",
    "versions.upd_started": "⏳ Updating {names} to <code>{sha}</code>…",
    "versions.upd_done": "⬆️ Update to <code>{sha}</code>:",
    "versions.upd_ok": "✅ <b>{name}</b>: <code>{before}</code> → <code>{after}</code>, hooks re-registered",
    "versions.upd_restarting": "; the agent restarts on the new code",
    "versions.upd_agent_old": "; restart its launch agent to load the new agent code",
    "versions.upd_failed": "❌ <b>{name}</b>: {why}",
    "versions.upd_unreachable": "❌ <b>{name}</b>: agent not reachable — {error}",
    "versions.upd_windows_hint": "Running windows keep their old plugin until they restart: /versions shows which, /restart all restarts the idle ones.",
    "cmd.desc_versions": "which code each machine and window runs",
    "versions.bot": "🤖 Bot: <code>{sha}</code>",
    "versions.this_machine": "This machine",
    "versions.elsewhere": "Other windows",
    "versions.machine": "🖥 <b>{name}</b>: <code>{sha}</code> ({branch})",
    "versions.machine_silent": "🖥 <b>{name}</b>: agent not answering, or too old for /version",
    "versions.dirty": "   ✏️ local edits: <code>{files}</code> — an update stops if it touches them",
    "versions.hooks_ok": "   🪝 hooks: current",
    "versions.hooks_stale": "   🪝 hooks: <b>not what this checkout installs</b> — run <code>hooks/install.py</code> there",
    "versions.hooks_unknown": "   🪝 hooks: could not check",
    "versions.no_windows": "   🪟 no windows",
    "versions.windows_ok": "   🪟 all {count} window(s) run this code",
    "versions.windows_stale": "   🪟 {count} of {total} window(s) run older code (restart them): {items}",
    "cmd.desc_who": "who else is in this working tree",
    "who.no_cwd": "🤷 This window did not report a folder, so there is nothing to compare.",
    "who.nobody": "🤷 Nobody is registered in <code>{cwd}</code> right now.",
    "who.header": "👥 <b>{count}</b> window(s) in <code>{cwd}</code>:",
    "who.window": "\n<b>{name}</b>{mark}",
    "who.this_one": " — this one",
    "who.window_idle": "  · has not edited anything recently",
    "who.file": "  · {file} — {age}",
    "who.more_files": "  · …and {count} more",
    "who.bash_caveat": "<i>Edits made through Bash are invisible here — only the editing tools report.</i>",

    # --- Errors --------------------------------------------------------------------
    "err.internal": "❌ Internal error. The bot has the logs, try again in a minute.",

}
