from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4


@dataclass(slots=True)
class TextPart:
    text: str
    type: Literal["text"] = "text"


@dataclass(slots=True)
class ImagePart:
    data: str       # base64
    mime_type: str
    type: Literal["image"] = "image"


ContentPart = TextPart | ImagePart


@dataclass(slots=True)
class PingResult:
    instance_name: str
    workspace: str


@dataclass(slots=True)
class WindowStatus:
    instance_name: str
    workspace: str
    is_working: bool
    progress_lines: list[str]
    last_edit_ts: float | None  # ms epoch from the plugin, or None if idle
    # "Needs attention" flags — true while a hook is blocking on Telegram input.
    # Older plugin builds didn't report these; the client defaults them to False.
    pending_approve: bool = False
    pending_ask: bool = False
    pending_plan: bool = False
    # Rolling buffer of recent in-window activity (tool calls + user/Claude
    # messages). Survives across turns so the bot's status panel can show what
    # happened most recently even when the window is idle. Empty on older
    # plugin builds.
    recent_events: list[str] = field(default_factory=list)


def make_request_id() -> str:
    return str(uuid4())
