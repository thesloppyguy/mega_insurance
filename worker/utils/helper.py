from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

from livekit import api, rtc

logger = logging.getLogger(__name__)


@dataclass
class RecordingEgressTarget:
    role: str
    identity: str | None
    room_name: str
    organization_id: str
    session_id: str


def resolve_user_participant(room: rtc.Room) -> rtc.RemoteParticipant | None:
    """Prefer the human participant; skip agent / avatar workers."""
    agent_kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT

    def _is_agent(participant: rtc.RemoteParticipant) -> bool:
        kind = getattr(participant, "kind", None)
        attrs = getattr(participant, "attributes", None) or {}
        identity = (participant.identity or "").lower()
        if kind == agent_kind:
            return True
        if attrs.get("lk.publish_on_behalf"):
            return True
        if identity.startswith(("anam-", "avatar-", "spatialreal-", "spatius-")):
            return True
        return False

    for participant in room.remote_participants.values():
        if not _is_agent(participant):
            return participant
    return None


def collect_recording_egresses(
    room: rtc.Room,
    *,
    organization_id: str,
    session_id: str,
    room_name: str,
    user_identity: str | None,
    avatar_identity: str | None,
) -> list[RecordingEgressTarget]:
    targets: list[RecordingEgressTarget] = [
        RecordingEgressTarget(
            role="room",
            identity=None,
            room_name=room_name,
            organization_id=organization_id,
            session_id=session_id,
        )
    ]
    if user_identity:
        targets.append(
            RecordingEgressTarget(
                role="user",
                identity=user_identity,
                room_name=room_name,
                organization_id=organization_id,
                session_id=session_id,
            )
        )
    if avatar_identity:
        targets.append(
            RecordingEgressTarget(
                role="avatar",
                identity=avatar_identity,
                room_name=room_name,
                organization_id=organization_id,
                session_id=session_id,
            )
        )
    return targets


def recording_egresses_payload(targets: list[RecordingEgressTarget]) -> list[dict[str, Any]]:
    return [
        {
            "role": t.role,
            "identity": t.identity,
            "room_name": t.room_name,
            "organization_id": t.organization_id,
            "session_id": t.session_id,
        }
        for t in targets
    ]


async def start_recording_egresses(
    *,
    room_name: str,
    targets: list[RecordingEgressTarget],
) -> list[dict[str, Any]]:
    url = os.getenv("LIVEKIT_URL", "")
    key = os.getenv("LIVEKIT_API_KEY", "")
    secret = os.getenv("LIVEKIT_API_SECRET", "")
    if not (url and key and secret):
        logger.error("local egress fallback missing LiveKit credentials")
        return []

    results: list[dict[str, Any]] = []
    lk = api.LiveKitAPI(url, key, secret)
    try:
        for target in targets:
            filepath = f"/tmp/mavrik_{room_name}_{target.role}.mp4"
            file_output = api.EncodedFileOutput(
                filepath=filepath,
                file_type=api.EncodedFileType.MP4,
            )
            try:
                if target.identity:
                    info = await lk.egress.start_participant_egress(
                        api.ParticipantEgressRequest(
                            room_name=room_name,
                            identity=target.identity,
                            file_outputs=[file_output],
                        )
                    )
                else:
                    info = await lk.egress.start_room_composite_egress(
                        api.RoomCompositeEgressRequest(
                            room_name=room_name,
                            layout="speaker",
                            file_outputs=[file_output],
                        )
                    )
                results.append(
                    {
                        "role": target.role,
                        "egress_id": getattr(info, "egress_id", None),
                        "filepath": filepath,
                    }
                )
            except Exception:
                logger.exception("local egress failed role=%s", target.role)
    finally:
        await lk.aclose()
    return results


async def dial_outbound_sip(*_args: Any, **_kwargs: Any) -> None:
    """Phone dialing is out of scope for the self-contained session stack."""
    logger.warning("dial_outbound_sip called but telephony is disabled in this build")
