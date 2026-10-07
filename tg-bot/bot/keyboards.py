from __future__ import annotations

from dataclasses import dataclass

import hashlib

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

from bot.i18n import t


# Reply-keyboard labels. FUNCTIONS, not constants, on purpose: a module constant
# is evaluated at import time, which happens before i18n.configure() has read
# bot.locale — so the keyboard would silently render in the default language no
# matter what the deployment asked for. These labels are also INPUT (a reply
# button sends its own text back, and bot/messages.py matches on it), so the
# rendering side and the matching side must resolve the same value at the same
# moment.
def settings_button_text() -> str:
    return t("kb.settings")


def status_windows_button_text() -> str:
    return t("kb.windows")


def back_button_text() -> str:
    return t("kb.back")


def status_list_button_text() -> str:
    return t("kb.status")


def save_button_text() -> str:
    return t("kb.save")


def launch_button_text() -> str:
    return t("kb.launch")


@dataclass(slots=True)
class WindowOption:
    name: str
    button_text: str
    label: str
    available: bool


def build_status_windows_keyboard(options: list[WindowOption]) -> InlineKeyboardMarkup:
    """Inline list — tap a window to see its current progress."""
    rows = [
        [InlineKeyboardButton(text=option.label, callback_data=f"wstatus:show:{cb_token(option.name)}")]
        for option in options
    ]
    return InlineKeyboardMarkup(rows)


def build_status_refresh_keyboard(instance_key: str) -> InlineKeyboardMarkup:
    """Per-window status panel keyboard. Switching is handled by the
    quick-switch reply keyboard (📊 Окна → window button), not from here —
    this panel is informational only."""
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(text=t("kb.refresh"), callback_data=f"wstatus:show:{cb_token(instance_key)}"),
        InlineKeyboardButton(text=t("kb.back_to_list"), callback_data="wstatus:list"),
    ]])


def build_window_keyboard(options: list[WindowOption]) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=option.label, callback_data=f"window:{cb_token(option.name)}")]
        for option in options
    ]
    return InlineKeyboardMarkup(rows)


def build_settings_root_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text=t("kb.perm_by_workspace"), callback_data="settings:perm")],
        [InlineKeyboardButton(text=t("kb.default_window"), callback_data="settings:defwin")],
    ])


def cb_token(name: str) -> str:
    """Short stable handle for a workspace name, used in callback_data.

    Telegram caps callback_data at 64 BYTES and rejects the WHOLE message if any
    single button breaks it — so one long name kills the entire keyboard, not just
    its own row (live case 2026-09-09: a Codex chat slugged from a URL,
    "https-getpostingboard-dev-…-codex", made `launch:go:<title>` 67 bytes and the
    launch button silently stopped working). A 12-hex digest keeps every button at
    22 bytes regardless of the name.

    That 2026-09-09 fix was applied to the launch picker only, and the same name
    then broke four more keyboards — measured live on 2026-09-15, the same window
    produced 67, 70, 73 and 88-byte buttons for the permissions menu, window
    status, default-window picker and mode confirmation. Every keyboard that
    embeds a workspace name goes through here now.
    """
    return hashlib.sha256(name.encode("utf-8")).hexdigest()[:12]


def resolve_cb_token(token: str, names) -> str | None:
    """Turn a cb_token back into the name it came from, or None.

    Falls back to treating `token` as the raw name so a keyboard sent BEFORE this
    change still works — those messages stay tappable in the chat history.
    """
    for name in names:
        if cb_token(name) == token:
            return name
    return token if token in set(names) else None


def build_launch_keyboard(
    workspaces: list[tuple[str, str]],
    tabs: list[str] | None = None,
    current: str = "",
) -> InlineKeyboardMarkup:
    """Picker of registered-but-offline workspaces to start. `workspaces` is
    [(title, cwd)] from launcher.list_launchable; the callback carries a short
    token (see cb_token), resolved back to the title on the way in.

    `tabs` are machine labels — one row of them across the top, the open one
    marked. Only drawn when there are at least two: a single machine needs no
    tab to choose it, and a lone tab button would just be a label pretending to
    be a control."""
    rows: list[list[InlineKeyboardButton]] = []
    if tabs and len(tabs) > 1:
        rows.append([
            InlineKeyboardButton(
                text=f"▸ {label}" if label == current else label,
                callback_data=f"launch:tab:{cb_token(label)}",
            )
            for label in tabs
        ])
    rows += [
        [InlineKeyboardButton(text=f"🚀 {title}", callback_data=f"launch:go:{cb_token(title)}")]
        for title, _cwd in workspaces
    ]
    # Refresh stays on the open tab, or the picker would jump machines under the
    # person's finger.
    refresh = "launch:list" if not current else f"launch:tab:{cb_token(current)}"
    rows.append([InlineKeyboardButton(text=t("kb.refresh"), callback_data=refresh)])
    return InlineKeyboardMarkup(rows)


def build_default_window_keyboard(options: list[WindowOption], current_default: str | None) -> InlineKeyboardMarkup:
    """Picker for the global default window — the one activated on /start and
    when the current active window disappears."""
    rows: list[list[InlineKeyboardButton]] = []
    for option in options:
        marker = "✅ " if option.name == current_default else ""
        rows.append([InlineKeyboardButton(
            text=f"{marker}{option.label}",
            callback_data=f"settings:setdef:{cb_token(option.name)}",
        )])
    if current_default is not None:
        rows.append([InlineKeyboardButton(
            text=t("kb.clear_default_override"),
            callback_data="settings:cleardef",
        )])
    rows.append([InlineKeyboardButton(text=t("kb.back"), callback_data="settings:root")])
    return InlineKeyboardMarkup(rows)


def build_permissions_keyboard(items: list[tuple[str, str]], mode_labels: dict[str, str]) -> InlineKeyboardMarkup:
    """items: list of (workspace_name, canonical_mode). Each row opens the mode picker for that workspace."""
    rows: list[list[InlineKeyboardButton]] = []
    for workspace, mode in items:
        label = mode_labels.get(mode, mode)
        rows.append([InlineKeyboardButton(
            text=f"{label}  ·  {workspace}",
            callback_data=f"perm:pick:{cb_token(workspace)}",
        )])
    rows.append([InlineKeyboardButton(text=t("kb.back_to_settings"), callback_data="settings:root")])
    return InlineKeyboardMarkup(rows)


def build_permission_mode_picker(
    workspace: str,
    current_mode: str,
    modes: list[str],
    mode_labels: dict[str, str],
    bypass_mode: str,
) -> InlineKeyboardMarkup:
    """Per-workspace mode selector. Bypass goes through a confirm dialog; others apply directly."""
    rows: list[list[InlineKeyboardButton]] = []
    for mode in modes:
        marker = "✅ " if mode == current_mode else ""
        label = mode_labels[mode]
        # Switching INTO bypass requires confirmation; switching OUT of bypass to anything
        # else just applies (you can't accidentally make things less permissive).
        if mode == bypass_mode and current_mode != bypass_mode:
            cb = f"perm:confirm:{cb_token(workspace)}:{mode}"
        else:
            cb = f"perm:set:{cb_token(workspace)}:{mode}"
        rows.append([InlineKeyboardButton(text=f"{marker}{label}", callback_data=cb)])
    rows.append([InlineKeyboardButton(text=t("kb.back_to_list"), callback_data="perm:list")])
    return InlineKeyboardMarkup(rows)


def build_permission_confirm_keyboard(workspace: str, bypass_mode: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text=t("kb.confirm_bypass"), callback_data=f"perm:set:{cb_token(workspace)}:{bypass_mode}")],
        [InlineKeyboardButton(text=t("kb.back"), callback_data=f"perm:pick:{cb_token(workspace)}")],
    ])


def build_window_reply_keyboard() -> ReplyKeyboardMarkup:
    """Main persistent keyboard with 📊 Окна / 🚀 Запуск / ⚙️ Настройки. Tapping
    📊 Окна swaps to the quick-switch keyboard (build_window_quick_switch_keyboard);
    🚀 Запуск opens the inline launchable-workspaces picker (== /launch)."""
    return ReplyKeyboardMarkup(
        [
            [
                KeyboardButton(text=status_windows_button_text()),
                KeyboardButton(text=launch_button_text()),
                KeyboardButton(text=settings_button_text()),
            ],
            [KeyboardButton(text=save_button_text())],
        ],
        resize_keyboard=True,
        one_time_keyboard=False,
        is_persistent=True,
        input_field_placeholder=t("kb.placeholder_main", windows=t("kb.windows")),
    )


def build_window_quick_switch_keyboard(display_names: list[str]) -> ReplyKeyboardMarkup:
    """Temporary reply keyboard shown after 📊 Окна — one button per registered
    window plus a control row [📈 Статус, ◀️ Назад]. Tapping a window is a
    pointer-only switch (no status pings); 📈 Статус opens the inline status
    list; ◀️ Назад restores the main keyboard."""
    rows: list[list[KeyboardButton]] = [
        [KeyboardButton(text=name)] for name in display_names
    ]
    rows.append([
        KeyboardButton(text=status_list_button_text()),
        KeyboardButton(text=back_button_text()),
    ])
    return ReplyKeyboardMarkup(
        rows,
        resize_keyboard=True,
        one_time_keyboard=False,
        is_persistent=True,
        input_field_placeholder=t("kb.placeholder_quick_switch", status=t("kb.status"), back=t("kb.back")),
    )


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/keyboards.py
    # The whole point: every keyboard that embeds a workspace name must stay
    # inside Telegram's 64-BYTE callback_data cap, because ONE oversized button
    # makes Telegram reject the entire sendMessage. The name below is real — a
    # live Codex window on 2026-09-15, which produced 67..88 byte buttons before
    # this change.
    LONG = "https-getpostingboard-dev-https-getpostingboard-dev-codex"
    CYRILLIC = "очень-длинное-имя-воркспейса-по-русски"   # 2 bytes per letter

    def cap(data: str) -> int:
        return len(data.encode("utf-8"))

    for name in (LONG, CYRILLIC, "short", ""):
        tok = cb_token(name)
        assert len(tok) == 12 and ":" not in tok, tok
        for data in (
            f"window:{tok}",
            f"wstatus:show:{tok}",
            f"settings:setdef:{tok}",
            f"perm:pick:{tok}",
            f"perm:confirm:{tok}:bypassPermissions",
            f"perm:set:{tok}:bypassPermissions",
            f"launch:go:{tok}",
        ):
            assert cap(data) <= 64, f"{cap(data)} bytes: {data}"

    # Without the token these buttons really do break the cap — otherwise this
    # check would pass even if someone reverted the fix. Measured live for this
    # exact name: 88 / 73 / 70 / 67 bytes.
    assert cap(f"perm:confirm:{LONG}:bypassPermissions") > 64
    assert cap(f"settings:setdef:{LONG}") > 64
    assert cap(f"wstatus:show:{LONG}") > 64
    assert cap(f"perm:pick:{LONG}") > 64
    # `window:` with this same name lands on EXACTLY 64 — inside the cap by one
    # byte, which is why the window picker kept working while the others died.
    # One more character in the name and it would have gone too; it is tokenised
    # along with the rest rather than left sitting on the boundary.
    assert cap(f"window:{LONG}") == 64

    # Round-trip, including the pre-change keyboards still in the chat history.
    names = [LONG, CYRILLIC, "short"]
    assert resolve_cb_token(cb_token(LONG), names) == LONG
    assert resolve_cb_token(cb_token(CYRILLIC), names) == CYRILLIC
    assert resolve_cb_token(LONG, names) == LONG, "raw name must still resolve"
    assert resolve_cb_token("deadbeef1234", names) is None
    assert resolve_cb_token("never-registered", names) is None
    # Distinct names must not collide into one token.
    assert len({cb_token(n) for n in names}) == len(names)
    # /launch tabs: drawn only for several machines, the open one marked, and
    # Refresh staying on it instead of throwing the person back to machine one.
    ws = [("api-gateway", "/w/api-gateway"), ("webapp", "/w/webapp")]
    rows = [[(b.text, b.callback_data) for b in row]
            for row in build_launch_keyboard(ws, ["Mac", "Windows"], "Mac").inline_keyboard]
    assert rows[0] == [("▸ Mac", f"launch:tab:{cb_token('Mac')}"),
                       ("Windows", f"launch:tab:{cb_token('Windows')}")], rows[0]
    assert len(rows) == 4, rows
    assert rows[-1][0][1] == f"launch:tab:{cb_token('Mac')}", "refresh stays on the open tab"

    one = build_launch_keyboard(ws, [""], "").inline_keyboard
    assert len(one) == 3, "a single machine needs no tab row"
    assert one[-1][0].callback_data == "launch:list"

    empty = build_launch_keyboard([], ["Mac", "Windows"], "Windows").inline_keyboard
    assert len(empty) == 2 and empty[0][1].text == "▸ Windows", \
        "an empty machine keeps its tabs, or the other one becomes a dead end"

    # Telegram rejects the WHOLE sendMessage over ONE oversized callback_data.
    for row in rows + [[(b.text, b.callback_data) for b in r] for r in empty]:
        for _text, data in row:
            assert len(data.encode()) <= 64, (data, len(data.encode()))

    print("keyboards self-check OK")

