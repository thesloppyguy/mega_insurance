"""HTTP client for worker → backend internal APIs.

Payloads follow packages/api/modules/sessions/WORKER_CONTRACT.md (camelCase + UPPER enums).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

# Eagerly import the HTTP stack at process load so the first AsyncClient on a
# LiveKit job loop does not stall importing (agents warn above ~100ms).
import h11  # noqa: F401
import h11._events  # noqa: F401
import httpcore  # noqa: F401
import httpcore._backends.sync  # noqa: F401
import httpcore._backends.anyio  # noqa: F401
import httpcore._sync.connection  # noqa: F401
import httpcore._async.connection  # noqa: F401

logger = logging.getLogger(__name__)

_STATUS_MAP = {
    "queued": "QUEUED",
    "active": "ACTIVE",
    "completed": "COMPLETED",
    "failed": "FAILED",
    "cancelled": "CANCELLED",
    "canceled": "CANCELLED",
}

_END_REASON_MAP = {
    "completed": "COMPLETED",
    "participant_left": "PARTICIPANT_LEFT",
    "room_finished": "ROOM_FINISHED",
    "error": "ERROR",
    "cancelled": "CANCELLED",
    "canceled": "CANCELLED",
    "timeout": "TIMEOUT",
    "unknown": "COMPLETED",
    "transfer": "COMPLETED",
    "agent_hangup": "COMPLETED",
}

_ACTOR_MAP = {
    "agent": "AGENT",
    "user": "USER",
    "system": "SYSTEM",
    "worker": "WORKER",
}

_TOOL_STATUS_MAP = {
    "pending": "PENDING",
    "running": "RUNNING",
    "completed": "COMPLETED",
    "failed": "FAILED",
}


def _upper_enum(value: str | None, mapping: dict[str, str]) -> str | None:
    if value is None:
        return None
    key = value.strip()
    if not key:
        return None
    mapped = mapping.get(key.lower())
    if mapped is not None:
        return mapped
    upper = key.upper()
    if upper in mapping.values():
        return upper
    return upper


def _log_request_failure(
    action: str,
    session_id: str,
    exc: BaseException,
    *,
    response: httpx.Response | None = None,
) -> None:
    """Log backend failures without drowning the console on connect errors."""
    if isinstance(
        exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.TimeoutException)
    ):
        logger.warning(
            "Backend unreachable while %s for %s (%s: %s)",
            action,
            session_id,
            type(exc).__name__,
            exc,
        )
        return
    detail = ""
    if response is not None:
        body = (response.text or "")[:500]
        detail = f" status={response.status_code} body={body!r}"
    elif isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
        body = (exc.response.text or "")[:500]
        detail = f" status={exc.response.status_code} body={body!r}"
    logger.exception("Failed to %s for %s%s", action, session_id, detail)


class BackendClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Worker-Api-Key": self._api_key,
        }

    def _enabled(self) -> bool:
        return bool(self._api_key)

    async def patch_session_lifecycle(
        self,
        session_id: str,
        *,
        status: str,
        livekit_job_id: str | None = None,
        end_reason: str | None = None,
        error_message: str | None = None,
    ) -> bool:
        if not self._enabled():
            logger.warning("Worker API key not configured; skipping lifecycle update")
            return False
        mapped_status = _upper_enum(status, _STATUS_MAP)
        if mapped_status is None:
            logger.warning("Invalid lifecycle status %r; skipping update", status)
            return False
        payload: dict[str, Any] = {"status": mapped_status}
        if livekit_job_id is not None:
            payload["livekitJobId"] = livekit_job_id
        mapped_end = _upper_enum(end_reason, _END_REASON_MAP)
        if mapped_end is not None:
            if mapped_end not in _END_REASON_MAP.values():
                logger.warning(
                    "Unknown end_reason %r; omitting from lifecycle payload",
                    end_reason,
                )
            else:
                payload["endReason"] = mapped_end
        if error_message is not None:
            payload["errorMessage"] = error_message
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.patch(
                    f"{self._base_url}/internal/sessions/{session_id}/lifecycle",
                    json=payload,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("update session lifecycle", session_id, exc)
            return False

    async def create_session_event(
        self,
        session_id: str,
        *,
        event_type: str,
        actor: str = "AGENT",
        payload: dict[str, Any] | None = None,
    ) -> bool:
        if not self._enabled():
            return False
        mapped_actor = _upper_enum(actor, _ACTOR_MAP) or "AGENT"
        if mapped_actor not in _ACTOR_MAP.values():
            mapped_actor = "AGENT"
        body = {
            "eventType": event_type,
            "actor": mapped_actor,
            "payload": payload or {},
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/events",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("create session event", session_id, exc)
            return False

    async def record_tool_call(
        self,
        session_id: str,
        *,
        tool_name: str,
        arguments: dict[str, Any],
        result: str,
        status: str = "COMPLETED",
        is_error: bool = False,
    ) -> bool:
        if not self._enabled():
            return False
        mapped_status = _upper_enum(status, _TOOL_STATUS_MAP) or "COMPLETED"
        if mapped_status not in _TOOL_STATUS_MAP.values():
            mapped_status = "FAILED" if is_error else "COMPLETED"
        body = {
            "toolName": tool_name,
            "arguments": arguments,
            "result": result,
            "status": mapped_status,
            "isError": is_error,
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/tool-calls",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("record tool call", session_id, exc)
            return False

    async def schedule_callback(
        self,
        *,
        session_id: str,
        scheduled_at: str,
        phone_number: str,
        campaign_id: str | None = None,
        contact_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not self._enabled():
            return None
        body: dict[str, Any] = {
            "sessionId": session_id,
            "scheduledAt": scheduled_at,
            "phoneNumber": phone_number,
        }
        if campaign_id:
            body["campaignId"] = campaign_id
        if contact_metadata:
            body["contactMetadata"] = contact_metadata
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/callbacks/schedule",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            _log_request_failure("schedule callback", session_id, exc)
            return None

    async def post_session_report(
        self,
        session_id: str,
        *,
        report: dict[str, Any],
        metrics: list[dict[str, Any]] | None = None,
        usage: dict[str, Any] | list[dict[str, Any]] | None = None,
        is_final: bool = True,
    ) -> bool:
        if not self._enabled():
            return False
        normalized_usage: dict[str, Any] | None
        if usage is None:
            normalized_usage = None
        elif isinstance(usage, list):
            normalized_usage = {"model_usage": usage}
        elif isinstance(usage, dict):
            normalized_usage = usage
        else:
            normalized_usage = {"raw": repr(usage)}

        body: dict[str, Any] = {
            "report": report,
            "metrics": metrics or [],
            "isFinal": is_final,
        }
        if normalized_usage is not None:
            body["usage"] = normalized_usage
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/report",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("post session report", session_id, exc)
            return False

    async def start_session_egress(
        self,
        session_id: str,
        *,
        tracks: list[dict[str, str]] | None = None,
        audio_only: bool = False,
    ) -> dict[str, Any] | None:
        """Start per-track egress via backend so path + EgressJob stay in sync."""
        if not self._enabled():
            logger.warning("Worker API key not configured; skipping egress start")
            return None
        body: dict[str, Any] = {"audioOnly": audio_only}
        if tracks:
            body["tracks"] = tracks
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/egress",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            _log_request_failure("start session egress", session_id, exc)
            return None

    async def register_session_egress(
        self,
        session_id: str,
        *,
        tracks: list[dict[str, str]],
        audio_only: bool = False,
    ) -> dict[str, Any] | None:
        """Register already-started LiveKit egress jobs so the dashboard can show them."""
        if not self._enabled():
            logger.warning("Worker API key not configured; skipping egress register")
            return None
        if not tracks:
            return None
        body: dict[str, Any] = {"audioOnly": audio_only, "tracks": tracks}
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/egress/register",
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            _log_request_failure("register session egress", session_id, exc)
            return None

    async def upload_session_file(
        self,
        session_id: str,
        *,
        filename: str,
        content: bytes,
        content_type: str = "application/octet-stream",
        display_name: str | None = None,
    ) -> dict[str, Any] | None:
        """Upload a file for the session end user (multipart)."""
        if not self._enabled():
            logger.warning("Worker API key not configured; skipping file upload")
            return None
        name = (display_name or filename or "upload").strip() or "upload"
        headers = {
            "Accept": "application/json",
            "X-Worker-Api-Key": self._api_key,
        }
        files = {
            "file": (filename or name, content, content_type),
        }
        data = {"name": name}
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{self._base_url}/internal/sessions/{session_id}/files",
                    headers=headers,
                    files=files,
                    data=data,
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            _log_request_failure("upload session file", session_id, exc)
            return None
