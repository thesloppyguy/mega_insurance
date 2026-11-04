"""Parse LiveKit job dispatch metadata for mavrik sessions."""

from __future__ import annotations

import json
from typing import Any


def parse_job_metadata(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    # Object-like (attrs / pydantic)
    out: dict[str, Any] = {}
    for key in (
        "session_id",
        "recording_enabled",
        "contact_metadata",
        "caller_name",
        "config",
    ):
        if hasattr(raw, key):
            out[key] = getattr(raw, key)
    return out


def resolve_session_id(metadata: dict[str, Any], fallback: str | None = None) -> str:
    sid = metadata.get("session_id")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()
    tools = metadata.get("tools_context")
    if isinstance(tools, dict):
        nested = tools.get("session_id")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return (fallback or "").strip()


def resolve_caller_name(metadata: dict[str, Any]) -> str:
    contact = metadata.get("contact_metadata")
    if isinstance(contact, dict):
        name = contact.get("caller_name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    direct = metadata.get("caller_name")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    return "there"
