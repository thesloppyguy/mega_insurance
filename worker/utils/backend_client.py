from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class BackendClient:
    def __init__(self, base_url: str, worker_api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.worker_api_key = worker_api_key

    def _headers(self) -> dict[str, str]:
        return {"X-Worker-Api-Key": self.worker_api_key}

    async def patch_session_lifecycle(
        self,
        session_id: str,
        *,
        status: str,
        livekit_job_id: str | None = None,
        end_reason: str | None = None,
    ) -> bool:
        payload: dict[str, Any] = {"status": status}
        if livekit_job_id is not None:
            payload["livekit_job_id"] = livekit_job_id
        if end_reason is not None:
            payload["end_reason"] = end_reason
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.patch(
                    f"{self.base_url}/sessions/{session_id}/lifecycle",
                    json=payload,
                    headers=self._headers(),
                )
                if resp.status_code >= 400:
                    logger.error(
                        "lifecycle patch failed status=%s body=%s",
                        resp.status_code,
                        resp.text,
                    )
                    return False
                return True
        except Exception:
            logger.exception("lifecycle patch error session_id=%s", session_id)
            return False

    async def post_session_report(
        self,
        session_id: str,
        *,
        report: dict[str, Any],
        usage: dict[str, Any] | list[Any] | None = None,
        metrics: list[dict[str, Any]] | None = None,
        is_final: bool = False,
        underwriting_report: dict[str, Any] | None = None,
    ) -> bool:
        payload: dict[str, Any] = {
            "report": report,
            "usage": usage,
            "metrics": metrics or [],
            "is_final": is_final,
        }
        if underwriting_report is not None:
            payload["underwriting_report"] = underwriting_report
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{self.base_url}/sessions/{session_id}/report",
                    json=payload,
                    headers=self._headers(),
                )
                if resp.status_code >= 400:
                    logger.error(
                        "post report failed status=%s body=%s",
                        resp.status_code,
                        resp.text,
                    )
                    return False
                return True
        except Exception:
            logger.exception("post report error session_id=%s", session_id)
            return False

    async def start_session_egress(
        self,
        session_id: str,
        *,
        tracks: list[dict[str, Any]],
        audio_only: bool = False,
    ) -> dict[str, Any] | None:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self.base_url}/sessions/{session_id}/egress",
                    json={"tracks": tracks, "audio_only": audio_only},
                    headers=self._headers(),
                )
                if resp.status_code >= 400:
                    logger.error(
                        "egress start failed status=%s body=%s",
                        resp.status_code,
                        resp.text,
                    )
                    return None
                return resp.json()
        except Exception:
            logger.exception("egress start error session_id=%s", session_id)
            return None

    async def create_session_event(
        self,
        session_id: str,
        *,
        event_type: str,
        actor: str = "WORKER",
        payload: dict[str, Any] | None = None,
    ) -> bool:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{self.base_url}/sessions/{session_id}/events",
                    json={
                        "event_type": event_type,
                        "actor": actor,
                        "payload": payload or {},
                    },
                    headers=self._headers(),
                )
                return resp.status_code < 400
        except Exception:
            logger.exception("create event error session_id=%s", session_id)
            return False

    async def get_session(self, session_id: str) -> dict[str, Any] | None:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(f"{self.base_url}/sessions/{session_id}")
                if resp.status_code >= 400:
                    return None
                return resp.json()
        except Exception:
            logger.exception("get session error session_id=%s", session_id)
            return None

    async def upload_asset_bytes(
        self,
        session_id: str,
        *,
        kind: str,
        filename: str,
        content: bytes,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        import json

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self.base_url}/sessions/{session_id}/assets",
                    data={"kind": kind, "meta_json": json.dumps(meta or {})},
                    files={"file": (filename, content)},
                )
                if resp.status_code >= 400:
                    logger.error("asset upload failed status=%s", resp.status_code)
                    return None
                return resp.json()
        except Exception:
            logger.exception("asset upload error session_id=%s", session_id)
            return None
