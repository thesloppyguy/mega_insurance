from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from livekit import api

from .config import EGRESS_DIR, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, ensure_dirs

logger = logging.getLogger(__name__)


def _lk() -> api.LiveKitAPI:
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise RuntimeError("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are required")
    return api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)


def mint_token(
    *,
    room_name: str,
    identity: str,
    name: str,
    metadata: dict[str, Any],
    agent_name: str = "mavrik",
) -> str:
    if not (LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise RuntimeError("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are required")

    grant = api.VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(name)
        .with_grants(grant)
        .with_room_config(
            api.RoomConfiguration(
                agents=[
                    api.RoomAgentDispatch(
                        agent_name=agent_name,
                        metadata=json.dumps(metadata),
                    )
                ]
            )
        )
    )
    return token.to_jwt()


async def start_track_egresses(
    *,
    room_name: str,
    tracks: list[dict[str, Any]],
    audio_only: bool = False,
) -> list[dict[str, Any]]:
    """Start LiveKit egress jobs for requested tracks; write under data/egress."""
    ensure_dirs()
    results: list[dict[str, Any]] = []
    lk = _lk()
    try:
        for track in tracks:
            role = track.get("role") or "unknown"
            filepath = str(EGRESS_DIR / f"{room_name}_{role}.mp4")
            Path(filepath).parent.mkdir(parents=True, exist_ok=True)

            # Prefer participant composite when identity is known; else room composite once.
            identity = track.get("identity")
            file_output = api.EncodedFileOutput(
                filepath=filepath,
                file_type=api.EncodedFileType.MP4,
            )
            try:
                if identity:
                    req = api.ParticipantEgressRequest(
                        room_name=room_name,
                        identity=identity,
                        file_outputs=[file_output],
                        screen_share=False,
                    )
                    if audio_only:
                        req.video_encoding = None
                    info = await lk.egress.start_participant_egress(req)
                else:
                    info = await lk.egress.start_room_composite_egress(
                        api.RoomCompositeEgressRequest(
                            room_name=room_name,
                            layout="speaker",
                            file_outputs=[file_output],
                            audio_only=audio_only,
                        )
                    )
                results.append(
                    {
                        "role": role,
                        "egress_id": getattr(info, "egress_id", None),
                        "filepath": filepath,
                        "status": "started",
                    }
                )
            except Exception:
                logger.exception("failed to start egress role=%s room=%s", role, room_name)
                # Local-file fallback marker when cloud egress is unavailable.
                results.append(
                    {
                        "role": role,
                        "egress_id": None,
                        "filepath": filepath,
                        "status": "failed",
                        "error": "egress_start_failed",
                    }
                )
    finally:
        await lk.aclose()
    return results
