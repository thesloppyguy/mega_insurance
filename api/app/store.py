from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import ASSETS_DIR, SESSIONS_DIR, ensure_dirs

_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def create_session(
    *,
    organization_id: str,
    campaign_id: str | None,
    participant_name: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    ensure_dirs()
    session_id = f"sess_{uuid4().hex[:16]}"
    room_name = f"mavrik-{session_id}"
    record = {
        "session_id": session_id,
        "organization_id": organization_id,
        "campaign_id": campaign_id,
        "participant_name": participant_name,
        "room_name": room_name,
        "status": "created",
        "livekit_job_id": None,
        "end_reason": None,
        "config": config,
        "assets": [],
        "events": [],
        "egress": [],
        "livekit_report": None,
        "underwriting_report": None,
        "usage": None,
        "metrics": [],
        "created_at": _now(),
        "updated_at": _now(),
    }
    with _lock:
        _session_path(session_id).write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def get_session(session_id: str) -> dict[str, Any] | None:
    path = _session_path(session_id)
    if not path.exists():
        return None
    with _lock:
        return json.loads(path.read_text(encoding="utf-8"))


def update_session(session_id: str, **patch: Any) -> dict[str, Any] | None:
    with _lock:
        path = _session_path(session_id)
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
        record.update(patch)
        record["updated_at"] = _now()
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")
        return record


def append_event(session_id: str, event: dict[str, Any]) -> dict[str, Any] | None:
    with _lock:
        path = _session_path(session_id)
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding="utf-8"))
        event = {**event, "at": _now()}
        record.setdefault("events", []).append(event)
        record["updated_at"] = _now()
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")
        return record


def save_asset(
    session_id: str,
    *,
    kind: str,
    filename: str,
    content: bytes,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    ensure_dirs()
    session = get_session(session_id)
    if session is None:
        return None
    asset_id = f"asset_{uuid4().hex[:12]}"
    ext = Path(filename).suffix or ".bin"
    dest_dir = ASSETS_DIR / session_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{asset_id}{ext}"
    dest.write_bytes(content)
    asset = {
        "asset_id": asset_id,
        "kind": kind,
        "filename": filename,
        "path": str(dest),
        "meta": meta or {},
        "created_at": _now(),
    }
    with _lock:
        path = _session_path(session_id)
        record = json.loads(path.read_text(encoding="utf-8"))
        record.setdefault("assets", []).append(asset)
        record["updated_at"] = _now()
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return asset
