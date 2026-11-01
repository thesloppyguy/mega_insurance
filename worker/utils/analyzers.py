from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .muse_client import ESTIMATE_DISCLOSURE, MuseClient
from .schemas import (
    BodyScanResult,
    FaceEnrollResult,
    FaceMatchReport,
    Finding,
    KycResult,
    LivenessResult,
    PrecheckResult,
    ProctorEvent,
    ProctoringResult,
)

logger = logging.getLogger(__name__)


def _status_from_bool(ok: bool, *, review_on_false: bool = True) -> str:
    if ok:
        return "pass"
    return "review" if review_on_false else "fail"


class MuseAnalyzers:
    def __init__(self, client: MuseClient | None = None) -> None:
        self.client = client or MuseClient()

    async def precheck(self, image_bytes: bytes) -> PrecheckResult:
        img = MuseClient.image_part_from_bytes(image_bytes)
        data = await self.client.spark_json(
            system=(
                "You assess video-call framing for an insurance underwriting interview. "
                "Return JSON only."
            ),
            user_text=(
                "Evaluate lighting, face visibility, and framing. Return JSON keys: "
                "lighting_ok (bool), face_visible (bool), framing_ok (bool), "
                "guidance (string), status (pass|review|fail), findings (list of "
                "{code,severity,message})."
            ),
            images=[img],
        )
        lighting_ok = bool(data.get("lighting_ok"))
        face_visible = bool(data.get("face_visible"))
        framing_ok = bool(data.get("framing_ok"))
        ok = lighting_ok and face_visible and framing_ok
        return PrecheckResult(
            status=data.get("status") or _status_from_bool(ok),
            lighting_ok=lighting_ok,
            face_visible=face_visible,
            framing_ok=framing_ok,
            guidance=str(data.get("guidance") or ""),
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw=data,
            disclosure=ESTIMATE_DISCLOSURE,
        )

    async def enroll_face(self, image_bytes: bytes) -> FaceEnrollResult:
        img = MuseClient.image_part_from_bytes(image_bytes)
        data = await self.client.spark_json(
            system="You validate a selfie for face enrollment. Return JSON only.",
            user_text=(
                "Is there a single clear frontal face suitable for enrollment? "
                "Return JSON: enrolled (bool), status, scores.quality (0-1), findings."
            ),
            images=[img],
        )
        enrolled = bool(data.get("enrolled"))
        scores = data.get("scores") if isinstance(data.get("scores"), dict) else {}
        return FaceEnrollResult(
            status=data.get("status") or _status_from_bool(enrolled),
            enrolled=enrolled,
            scores={k: float(v) for k, v in scores.items() if isinstance(v, (int, float))},
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw=data,
        )

    async def liveness(self, frames: list[bytes]) -> LivenessResult:
        images = [MuseClient.image_part_from_bytes(b) for b in frames[:6]]
        data = await self.client.spark_json(
            system="You perform a basic liveness check from ordered frames. Return JSON only.",
            user_text=(
                "Frames are sequential. Detect if a live person is present (blink/motion/"
                "pose change). Return JSON: liveness_passed (bool), spoof_suspected (bool), "
                "status, scores.confidence (0-1), findings."
            ),
            images=images,
        )
        passed = bool(data.get("liveness_passed"))
        spoof = bool(data.get("spoof_suspected"))
        scores = data.get("scores") if isinstance(data.get("scores"), dict) else {}
        return LivenessResult(
            status=data.get("status") or ("fail" if spoof else _status_from_bool(passed)),
            liveness_passed=passed and not spoof,
            spoof_suspected=spoof,
            scores={k: float(v) for k, v in scores.items() if isinstance(v, (int, float))},
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw=data,
        )

    async def kyc_document(
        self,
        id_image: bytes,
        selfie: bytes | None = None,
    ) -> KycResult:
        images = [MuseClient.image_part_from_bytes(id_image)]
        if selfie:
            images.append(MuseClient.image_part_from_bytes(selfie))
        data = await self.client.spark_json(
            system=(
                "You extract KYC ID fields and optionally match to a selfie. "
                "Return JSON only. Do not invent ID numbers if unreadable."
            ),
            user_text=(
                "First image is an ID document; second (if present) is a selfie. "
                "Return JSON: document_type, extracted_fields (name, dob, id_number, "
                "expiry if visible), face_match_score (0-1 or null), status, findings, "
                "scores.ocr_confidence (0-1)."
            ),
            images=images,
        )
        fields = data.get("extracted_fields") if isinstance(data.get("extracted_fields"), dict) else {}
        score = data.get("face_match_score")
        return KycResult(
            status=str(data.get("status") or "review"),
            document_type=data.get("document_type"),
            extracted_fields=fields,
            face_match_score=float(score) if isinstance(score, (int, float)) else None,
            scores={
                k: float(v)
                for k, v in (data.get("scores") or {}).items()
                if isinstance(v, (int, float))
            }
            if isinstance(data.get("scores"), dict)
            else {},
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw=data,
            disclosure=ESTIMATE_DISCLOSURE,
        )

    async def body_scan(
        self,
        *,
        front: bytes | None,
        back: bytes | None,
        view: str = "combined",
    ) -> BodyScanResult:
        images: list[dict[str, Any]] = []
        if front:
            images.append(MuseClient.image_part_from_bytes(front))
        if back:
            images.append(MuseClient.image_part_from_bytes(back))

        # SAM person segmentation for assistive devices / person presence.
        sam_raw: dict[str, Any] = {}
        if images:
            try:
                sam_raw = await self.client.segment(
                    prompt=(
                        "person, wheelchair, cane, crutches, prosthetic, phone, laptop"
                    ),
                    image=images[0],
                )
            except Exception:
                logger.exception("SAM segmentation failed")

        data = await self.client.wonder_json(
            system=(
                "You are an underwriting visual assessor. Produce careful visual estimates "
                "only. Always treat numbers as AI estimates, not medical measurements. "
                "Return JSON only."
            ),
            user_text=(
                "Analyze full-body capture(s). Image order: front then back when both present. "
                "Return JSON with: status, estimates: {height_cm, weight_kg, bmi, "
                "heart_rate_bpm, respiratory_rate_bpm, fitness_assessment}, "
                "physical_conditions (list of strings: impairments, amputations, mobility "
                "limitations, abnormal posture, deformities, swelling, asymmetry, "
                "assistive_devices), findings, scores.confidence (0-1), "
                "risk_indicators (list of strings)."
            ),
            images=images,
        )
        estimates = data.get("estimates") if isinstance(data.get("estimates"), dict) else {}
        conditions = data.get("physical_conditions") or []
        if not isinstance(conditions, list):
            conditions = [str(conditions)]
        return BodyScanResult(
            status=str(data.get("status") or "review"),
            view=view if view in ("front", "back", "combined") else "combined",
            estimates=estimates,
            physical_conditions=[str(c) for c in conditions],
            scores={
                k: float(v)
                for k, v in (data.get("scores") or {}).items()
                if isinstance(v, (int, float))
            }
            if isinstance(data.get("scores"), dict)
            else {},
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw={"muse": data, "sam": sam_raw},
            disclosure=ESTIMATE_DISCLOSURE,
        )

    async def face_match(self, selfie: bytes, id_face_or_doc: bytes) -> FaceMatchReport:
        images = [
            MuseClient.image_part_from_bytes(selfie),
            MuseClient.image_part_from_bytes(id_face_or_doc),
        ]
        data = await self.client.wonder_json(
            system="Compare two faces for identity verification. Return JSON only.",
            user_text=(
                "Image 1 is selfie, image 2 is ID photo/document. Return JSON: "
                "match_score (0-1), matched (bool), status, findings."
            ),
            images=images,
        )
        score = data.get("match_score")
        matched = data.get("matched")
        return FaceMatchReport(
            status=str(data.get("status") or "review"),
            match_score=float(score) if isinstance(score, (int, float)) else None,
            matched=bool(matched) if matched is not None else None,
            findings=[Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)],
            raw=data,
            disclosure=ESTIMATE_DISCLOSURE,
        )

    async def proctor_frame(self, image_bytes: bytes) -> ProctorEvent:
        img = MuseClient.image_part_from_bytes(image_bytes)
        sam = await self.client.segment(
            prompt="person, face, phone, laptop, tablet, second screen",
            image=img,
        )
        data = await self.client.spark_json(
            system="You are a live proctoring vision checker. Return JSON only.",
            user_text=(
                "Assess this frame. Return JSON: face_count (int), looking_away (bool), "
                "device_detected (bool), extra_person (bool), severity (info|low|medium|high), "
                "message (string). Use SAM hints if helpful: "
                f"{sam}"
            ),
            images=[img],
        )
        return ProctorEvent(
            face_count=int(data["face_count"]) if isinstance(data.get("face_count"), int) else None,
            looking_away=bool(data.get("looking_away")) if "looking_away" in data else None,
            device_detected=bool(data.get("device_detected"))
            if "device_detected" in data
            else None,
            extra_person=bool(data.get("extra_person")) if "extra_person" in data else None,
            severity=data.get("severity")
            if data.get("severity") in ("info", "low", "medium", "high")
            else "info",
            message=str(data.get("message") or ""),
        )

    async def summarize_proctoring(self, timeline: list[ProctorEvent]) -> ProctoringResult:
        high = sum(1 for e in timeline if e.severity == "high")
        medium = sum(1 for e in timeline if e.severity == "medium")
        if high >= 2:
            status = "fail"
        elif high >= 1 or medium >= 3:
            status = "review"
        elif timeline:
            status = "pass"
        else:
            status = "skipped"
        summary = (
            f"{len(timeline)} proctor samples; high={high}, medium={medium}. "
            "Flags are AI estimates of visual risk signals only."
        )
        return ProctoringResult(
            status=status,  # type: ignore[arg-type]
            timeline=timeline,
            summary=summary,
            disclosure=ESTIMATE_DISCLOSURE,
        )


def load_bytes(path: str | Path | None) -> bytes | None:
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    return p.read_bytes()
