from __future__ import annotations

import logging
from typing import Any

from .analyzers import MuseAnalyzers
from .backend_client import BackendClient
from .schemas import BodyScanResult, FaceEnrollResult, KycResult, LivenessResult, PrecheckResult

logger = logging.getLogger(__name__)


class CapturePipeline:
    """Handles in-session Muse analysis for capture RPC events."""

    def __init__(
        self,
        *,
        backend: BackendClient,
        session_id: str,
        analyzers: MuseAnalyzers | None = None,
    ) -> None:
        self.backend = backend
        self.session_id = session_id
        self.analyzers = analyzers or MuseAnalyzers()
        self.face_bytes: bytes | None = None
        self.id_bytes: bytes | None = None
        self.body_front: bytes | None = None
        self.body_back: bytes | None = None
        self.liveness_frames: list[bytes] = []
        self.results: dict[str, Any] = {}

    async def handle(
        self,
        event_type: str,
        detail: dict[str, Any],
    ) -> dict[str, Any]:
        image_b64 = detail.get("image_base64")
        images_b64 = detail.get("images_base64") or []
        view = detail.get("view")

        def _decode(b64: str) -> bytes:
            import base64

            if "," in b64:
                b64 = b64.split(",", 1)[1]
            return base64.b64decode(b64)

        try:
            if event_type == "precheck" and image_b64:
                raw = _decode(image_b64)
                result: PrecheckResult = await self.analyzers.precheck(raw)
                asset = await self.backend.upload_asset_bytes(
                    self.session_id,
                    kind="precheck",
                    filename="precheck.jpg",
                    content=raw,
                    meta={"status": result.status},
                )
                if asset:
                    result.evidence_asset_ids.append(asset["asset_id"])
                self.results["precheck"] = result.model_dump()
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="precheck_result",
                    payload=self.results["precheck"],
                )
                return self.results["precheck"]

            if event_type == "face_captured" and image_b64:
                raw = _decode(image_b64)
                self.face_bytes = raw
                result_f: FaceEnrollResult = await self.analyzers.enroll_face(raw)
                asset = await self.backend.upload_asset_bytes(
                    self.session_id,
                    kind="face",
                    filename="face.jpg",
                    content=raw,
                    meta={"enrolled": result_f.enrolled},
                )
                if asset:
                    result_f.evidence_asset_ids.append(asset["asset_id"])
                self.results["face"] = result_f.model_dump()
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="face_enrolled",
                    payload=self.results["face"],
                )
                return self.results["face"]

            if event_type == "liveness_captured":
                frames = [_decode(x) for x in images_b64 if isinstance(x, str)]
                if image_b64:
                    frames.append(_decode(image_b64))
                self.liveness_frames = frames
                result_l: LivenessResult = await self.analyzers.liveness(frames)
                for i, frame in enumerate(frames[:3]):
                    asset = await self.backend.upload_asset_bytes(
                        self.session_id,
                        kind="liveness",
                        filename=f"liveness_{i}.jpg",
                        content=frame,
                    )
                    if asset:
                        result_l.evidence_asset_ids.append(asset["asset_id"])
                self.results["liveness"] = result_l.model_dump()
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="liveness_result",
                    payload=self.results["liveness"],
                )
                return self.results["liveness"]

            if event_type == "id_captured" and image_b64:
                raw = _decode(image_b64)
                self.id_bytes = raw
                result_k: KycResult = await self.analyzers.kyc_document(
                    raw, selfie=self.face_bytes
                )
                asset = await self.backend.upload_asset_bytes(
                    self.session_id,
                    kind="kyc_id",
                    filename="id.jpg",
                    content=raw,
                    meta={"document_type": result_k.document_type},
                )
                if asset:
                    result_k.evidence_asset_ids.append(asset["asset_id"])
                self.results["kyc"] = result_k.model_dump()
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="kyc_result",
                    payload=self.results["kyc"],
                )
                return self.results["kyc"]

            if event_type == "body_captured" and image_b64:
                raw = _decode(image_b64)
                if view == "back":
                    self.body_back = raw
                    kind = "body_back"
                else:
                    self.body_front = raw
                    kind = "body_front"
                    view = view or "front"
                asset = await self.backend.upload_asset_bytes(
                    self.session_id,
                    kind=kind,
                    filename=f"{kind}.jpg",
                    content=raw,
                    meta={"view": view},
                )
                # Partial analysis per view; full combined happens in post-process.
                partial: BodyScanResult = await self.analyzers.body_scan(
                    front=self.body_front if view != "back" else None,
                    back=self.body_back if view == "back" else None,
                    view=view if view in ("front", "back") else "front",
                )
                if asset:
                    partial.evidence_asset_ids.append(asset["asset_id"])
                key = f"body_{view}"
                self.results[key] = partial.model_dump()
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="body_scan_partial",
                    payload=self.results[key],
                )
                return self.results[key]
        except Exception:
            logger.exception("capture pipeline failed event_type=%s", event_type)
            return {"status": "fail", "error": "analysis_failed", "event_type": event_type}

        return {"status": "skipped", "event_type": event_type}
