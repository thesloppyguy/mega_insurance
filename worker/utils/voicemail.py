from __future__ import annotations

from typing import Any


def resolve_voicemail_action(*_args: Any, **_kwargs: Any) -> str:
    return "continue"


def retry_scheduled_at_iso(*_args: Any, **_kwargs: Any) -> str | None:
    return None


def voicemail_leave_text(*_args: Any, **_kwargs: Any) -> str:
    return ""
