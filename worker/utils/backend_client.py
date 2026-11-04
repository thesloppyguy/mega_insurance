"""HTTP client for worker → mavrik Next.js /api routes."""

from __future__ import annotations

import logging
import os
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


def _log_request_failure(
    action: str,
    session_id: str,
    exc: BaseException,
    *,
    response: httpx.Response | None = None,
) -> None:
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


def backend_from_env() -> "BackendClient":
    base = (
        os.getenv("API_PUBLIC_BASE_URL")
        or os.getenv("BACKEND_BASE_URL")
        or ""
    ).rstrip("/")
    key = os.getenv("WORKER_API_KEY") or os.getenv("BACKEND_API_KEY") or ""
    return BackendClient(base, key)


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
        return bool(self._api_key and self._base_url)

    def _session_url(self, session_id: str, suffix: str) -> str:
        # API_PUBLIC_BASE_URL is typically .../api
        return f"{self._base_url}/sessions/{session_id}/{suffix}"

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
        payload: dict[str, Any] = {"status": status.lower()}
        if livekit_job_id is not None:
            payload["livekit_job_id"] = livekit_job_id
        if end_reason is not None:
            payload["end_reason"] = end_reason
        if error_message is not None:
            payload["error_message"] = error_message
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.patch(
                    self._session_url(session_id, "lifecycle"),
                    json=payload,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("update session lifecycle", session_id, exc)
            return False

    async def post_session_report(
        self,
        session_id: str,
        *,
        report: dict[str, Any],
        metrics: list[dict[str, Any]] | None = None,
        usage: dict[str, Any] | list[dict[str, Any]] | None = None,
        is_final: bool = True,
        underwriting_report: dict[str, Any] | None = None,
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
            "is_final": is_final,
        }
        if normalized_usage is not None:
            body["usage"] = normalized_usage
        if underwriting_report is not None:
            body["underwriting_report"] = underwriting_report
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    self._session_url(session_id, "report"),
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
            return True
        except Exception as exc:
            _log_request_failure("post session report", session_id, exc)
            return False

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        if not self._enabled():
            return None
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{self._base_url}/sessions/{session_id}",
                    headers=self._headers(),
                )
                response.raise_for_status()
                data = response.json()
                return data if isinstance(data, dict) else None
        except Exception as exc:
            _log_request_failure("get session", session_id, exc)
            return None

    async def upload_session_asset(
        self,
        session_id: str,
        *,
        kind: str,
        path: str,
        filename: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """POST multipart asset to ``/sessions/:id/assets``."""
        if not self._enabled():
            return None
        from pathlib import Path

        file_path = Path(path)
        if not file_path.is_file():
            logger.warning("Asset upload skipped; missing file %s", path)
            return None
        name = filename or file_path.name
        headers = {
            "Accept": "application/json",
            "X-Worker-Api-Key": self._api_key,
        }
        data: dict[str, str] = {"kind": kind}
        if meta:
            import json as _json

            data["meta_json"] = _json.dumps(meta)
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                with file_path.open("rb") as fh:
                    response = await client.post(
                        self._session_url(session_id, "assets"),
                        headers=headers,
                        data=data,
                        files={"file": (name, fh, "video/mp4")},
                    )
                response.raise_for_status()
                payload = response.json()
                return payload if isinstance(payload, dict) else None
        except Exception as exc:
            _log_request_failure("upload session asset", session_id, exc)
            return None

    async def start_session_egress(
        self,
        session_id: str,
        *,
        tracks: list[dict[str, str]] | None = None,
        audio_only: bool = False,
        composite: bool = True,
    ) -> dict[str, Any] | None:
        if not self._enabled():
            logger.warning("Worker API key not configured; skipping egress start")
            return None
        body: dict[str, Any] = {
            "audio_only": audio_only,
            "composite": composite,
        }
        if tracks:
            body["tracks"] = tracks
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    self._session_url(session_id, "egress"),
                    json=body,
                    headers=self._headers(),
                )
                response.raise_for_status()
                return response.json()
        except Exception as exc:
            _log_request_failure("start session egress", session_id, exc)
            return None
