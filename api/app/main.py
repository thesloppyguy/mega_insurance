from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import (
    API_PUBLIC_BASE_URL,
    DEFAULT_CAMPAIGN_ID,
    DEFAULT_ORG_ID,
    LIVEKIT_URL,
    WORKER_API_KEY,
    ensure_dirs,
)
from .dispatch import build_agent_dispatch_metadata
from .livekit_ops import mint_token, start_track_egresses
from . import store

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Mavrik API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateSessionRequest(BaseModel):
    participant_name: str = "Candidate"
    organization_id: str | None = None
    campaign_id: str | None = None
    use_avatar: bool = True
    recording_enabled: bool = True
    background_audio_enabled: bool = True
    anam_avatar_id: str | None = None
    anam_avatar_name: str | None = None


class TokenRequest(BaseModel):
    session_id: str
    participant_name: str | None = None


class LifecyclePatch(BaseModel):
    status: str
    livekit_job_id: str | None = None
    end_reason: str | None = None


class EgressRequest(BaseModel):
    tracks: list[dict[str, Any]] = Field(default_factory=list)
    audio_only: bool = False


class ReportRequest(BaseModel):
    report: dict[str, Any] = Field(default_factory=dict)
    usage: dict[str, Any] | list[Any] | None = None
    metrics: list[dict[str, Any]] = Field(default_factory=list)
    is_final: bool = False
    underwriting_report: dict[str, Any] | None = None


class EventRequest(BaseModel):
    event_type: str
    actor: str = "WORKER"
    payload: dict[str, Any] = Field(default_factory=dict)


def require_worker(x_worker_api_key: str | None = Header(default=None)) -> None:
    if x_worker_api_key != WORKER_API_KEY:
        raise HTTPException(status_code=401, detail="invalid worker api key")


@app.on_event("startup")  # noqa: B008 — simple local bootstrap
async def _startup() -> None:
    ensure_dirs()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sessions")
def create_session(body: CreateSessionRequest) -> dict[str, Any]:
    session = store.create_session(
        organization_id=body.organization_id or DEFAULT_ORG_ID,
        campaign_id=body.campaign_id or DEFAULT_CAMPAIGN_ID,
        participant_name=body.participant_name,
        config={
            "use_avatar": body.use_avatar,
            "recording_enabled": body.recording_enabled,
            "background_audio_enabled": body.background_audio_enabled,
            "anam_avatar_id": body.anam_avatar_id,
            "anam_avatar_name": body.anam_avatar_name,
        },
    )
    return {
        "session_id": session["session_id"],
        "room_name": session["room_name"],
        "join_path": f"/interview/{session['session_id']}",
        "report_path": f"/report/{session['session_id']}",
    }


@app.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return session


@app.post("/token")
def create_token(body: TokenRequest) -> dict[str, Any]:
    session = store.get_session(body.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    name = body.participant_name or session.get("participant_name") or "Candidate"
    identity = f"user_{session['session_id']}"
    metadata = build_agent_dispatch_metadata(session)
    try:
        token = mint_token(
            room_name=session["room_name"],
            identity=identity,
            name=name,
            metadata=metadata,
        )
    except Exception as exc:
        logger.exception("token mint failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "serverUrl": LIVEKIT_URL,
        "participantToken": token,
        "participantName": name,
        "roomName": session["room_name"],
        "sessionId": session["session_id"],
    }


@app.patch("/sessions/{session_id}/lifecycle")
def patch_lifecycle(
    session_id: str,
    body: LifecyclePatch,
    _: None = Depends(require_worker),
) -> dict[str, Any]:
    patch: dict[str, Any] = {"status": body.status}
    if body.livekit_job_id is not None:
        patch["livekit_job_id"] = body.livekit_job_id
    if body.end_reason is not None:
        patch["end_reason"] = body.end_reason
    session = store.update_session(session_id, **patch)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, "status": session["status"]}


@app.post("/sessions/{session_id}/egress")
async def start_egress(
    session_id: str,
    body: EgressRequest,
    _: None = Depends(require_worker),
) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    try:
        results = await start_track_egresses(
            room_name=session["room_name"],
            tracks=body.tracks,
            audio_only=body.audio_only,
        )
    except Exception as exc:
        logger.exception("egress start failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    store.update_session(session_id, egress=(session.get("egress") or []) + results)
    return {"ok": True, "egresses": results}


@app.post("/sessions/{session_id}/assets")
async def upload_asset(
    session_id: str,
    kind: str = Form(...),
    file: UploadFile = File(...),
    meta_json: str | None = Form(None),
) -> dict[str, Any]:
    if store.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    content = await file.read()
    meta: dict[str, Any] = {}
    if meta_json:
        import json

        try:
            meta = json.loads(meta_json)
        except json.JSONDecodeError:
            meta = {"raw_meta": meta_json}
    asset = store.save_asset(
        session_id,
        kind=kind,
        filename=file.filename or f"{kind}.bin",
        content=content,
        meta=meta,
    )
    if asset is None:
        raise HTTPException(status_code=500, detail="asset save failed")
    return asset


@app.post("/sessions/{session_id}/report")
def post_report(
    session_id: str,
    body: ReportRequest,
    _: None = Depends(require_worker),
) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    patch: dict[str, Any] = {
        "livekit_report": body.report,
        "usage": body.usage,
        "metrics": body.metrics,
    }
    if body.underwriting_report is not None:
        patch["underwriting_report"] = body.underwriting_report
    elif body.is_final and session.get("underwriting_report") is None:
        # Keep prior enrichment if worker posts LiveKit report separately.
        pass
    updated = store.update_session(session_id, **patch)
    return {"ok": True, "session_id": updated["session_id"] if updated else session_id}


@app.get("/sessions/{session_id}/report")
def get_report(session_id: str) -> dict[str, Any]:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "session_id": session_id,
        "status": session.get("status"),
        "livekit_report": session.get("livekit_report"),
        "underwriting_report": session.get("underwriting_report"),
        "usage": session.get("usage"),
        "metrics": session.get("metrics"),
        "assets": session.get("assets"),
        "events": session.get("events"),
        "egress": session.get("egress"),
        "api_base": API_PUBLIC_BASE_URL,
    }


@app.post("/sessions/{session_id}/events")
def create_event(
    session_id: str,
    body: EventRequest,
    _: None = Depends(require_worker),
) -> dict[str, Any]:
    updated = store.append_event(
        session_id,
        {
            "event_type": body.event_type,
            "actor": body.actor,
            "payload": body.payload,
        },
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True}
