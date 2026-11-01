from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ESTIMATE_DISCLOSURE = (
    "These values are AI estimates derived from video/images only. They are not "
    "clinical measurements, medical advice, or a diagnosis. An underwriter should "
    "review before any coverage decision."
)


class Finding(BaseModel):
    code: str
    severity: Literal["info", "low", "medium", "high"] = "info"
    message: str


class SectionBase(BaseModel):
    status: Literal["pending", "pass", "review", "fail", "skipped"] = "pending"
    scores: dict[str, float] = Field(default_factory=dict)
    findings: list[Finding] = Field(default_factory=list)
    estimates: dict[str, Any] = Field(default_factory=dict)
    disclosure: str = ESTIMATE_DISCLOSURE
    evidence_asset_ids: list[str] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class PrecheckResult(SectionBase):
    lighting_ok: bool = False
    face_visible: bool = False
    framing_ok: bool = False
    guidance: str = ""


class FaceEnrollResult(SectionBase):
    enrolled: bool = False


class LivenessResult(SectionBase):
    liveness_passed: bool = False
    spoof_suspected: bool = False


class KycResult(SectionBase):
    document_type: str | None = None
    extracted_fields: dict[str, Any] = Field(default_factory=dict)
    face_match_score: float | None = None


class BodyScanResult(SectionBase):
    view: Literal["front", "back", "combined"] = "combined"
    physical_conditions: list[str] = Field(default_factory=list)


class ProctorEvent(BaseModel):
    at: str | None = None
    face_count: int | None = None
    looking_away: bool | None = None
    device_detected: bool | None = None
    extra_person: bool | None = None
    severity: Literal["info", "low", "medium", "high"] = "info"
    message: str = ""


class ProctoringResult(SectionBase):
    timeline: list[ProctorEvent] = Field(default_factory=list)
    summary: str = ""


class AudioAnalysisResult(SectionBase):
    transcript_excerpt: str | None = None


class FaceMatchReport(SectionBase):
    match_score: float | None = None
    matched: bool | None = None


class UnderwritingOutcome(BaseModel):
    recommendation: Literal["proceed", "manual_review", "decline_review"] = "manual_review"
    risk_indicators: list[str] = Field(default_factory=list)
    exception_flags: list[str] = Field(default_factory=list)
    notes: str = ""
    disclosure: str = ESTIMATE_DISCLOSURE


class UnderwritingSessionReport(BaseModel):
    session_id: str
    identity_liveness: SectionBase = Field(default_factory=SectionBase)
    face_matching: FaceMatchReport = Field(default_factory=FaceMatchReport)
    kyc: KycResult = Field(default_factory=KycResult)
    body_scan: BodyScanResult = Field(default_factory=BodyScanResult)
    proctoring: ProctoringResult = Field(default_factory=ProctoringResult)
    audio: AudioAnalysisResult = Field(default_factory=AudioAnalysisResult)
    underwriting_outcome: UnderwritingOutcome = Field(default_factory=UnderwritingOutcome)
    disclosure: str = ESTIMATE_DISCLOSURE
