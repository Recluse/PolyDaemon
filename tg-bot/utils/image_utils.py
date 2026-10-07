from __future__ import annotations

import base64


def encode_image_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def pick_image_mime_type(mime_type: str | None, default: str = "image/png") -> str:
    if mime_type and mime_type.startswith("image/"):
        return mime_type

    return default