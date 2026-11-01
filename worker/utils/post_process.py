from __future__ import annotations

import logging
from typing import Any

from .analyzers import MuseAnalyzers, load_bytes
from .backend_client import BackendClient
from .muse_client import ESTIMATE_DISCLOSURE
from .schemas import (
    AudioAnalysisResult,
    BodyScanResult,
    Finding,
    UnderwritingOutcome,
    UnderwritingSessionReport,
)

logger = logging.getLogger(__name__)


async def build_underwriting_report(
    *,
    backend: BackendClient,
    session_id: str,
    capture_results: dict[str, Any],
    proctor_summary: dict[str, Any] | None,
    chat_history: dict[str, Any] | list[Any] | None,
    analyzers: MuseAnalyzers | None = None,
) -> UnderwritingSessionReport:
    analyzers = analyzers or MuseAnalyzers()
    session = await backend.get_session(session_id)
    assets = (session or {}).get("assets") or []

    def _asset_bytes(kind: str) -> bytes | None:
        for asset in reversed(assets):
            if asset.get("kind") == kind:
                return load_bytes(asset.get("path"))
        return None

    face = _asset_bytes("face")
    kyc_id = _asset_bytes("kyc_id")
    body_front = _asset_bytes("body_front")
    body_back = _asset_bytes("body_back")

    report = UnderwritingSessionReport(session_id=session_id, disclosure=ESTIMATE_DISCLOSURE)

    # Identity / liveness from capture pipeline
    face_section = capture_results.get("face") or {}
    liveness_section = capture_results.get("liveness") or {}
    report.identity_liveness.status = (
        "pass"
        if face_section.get("enrolled") and liveness_section.get("liveness_passed")
        else "review"
    )
    report.identity_liveness.raw = {"face": face_section, "liveness": liveness_section}
    report.identity_liveness.disclosure = ESTIMATE_DISCLOSURE

    if face and kyc_id:
        try:
            report.face_matching = await analyzers.face_match(face, kyc_id)
        except Exception:
            logger.exception("face match report failed")
            report.face_matching.status = "review"
            report.face_matching.findings.append(
                Finding(code="face_match_error", severity="medium", message="Face match failed")
            )

    if capture_results.get("kyc"):
        from .schemas import KycResult

        try:
            report.kyc = KycResult.model_validate(capture_results["kyc"])
        except Exception:
            report.kyc.status = "review"
            report.kyc.raw = capture_results["kyc"]
    elif kyc_id:
        report.kyc = await analyzers.kyc_document(kyc_id, selfie=face)

    if body_front or body_back:
        try:
            report.body_scan = await analyzers.body_scan(
                front=body_front, back=body_back, view="combined"
            )
        except Exception:
            logger.exception("body scan report failed")
            # Prefer partials
            partial = capture_results.get("body_front") or capture_results.get("body_back")
            if partial:
                try:
                    report.body_scan = BodyScanResult.model_validate(partial)
                except Exception:
                    report.body_scan.status = "review"
                    report.body_scan.raw = partial or {}

    if proctor_summary:
        from .schemas import ProctoringResult

        try:
            report.proctoring = ProctoringResult.model_validate(proctor_summary)
        except Exception:
            report.proctoring.status = "review"
            report.proctoring.raw = proctor_summary

    # Audio / transcript analysis via Muse Wonder on chat text (avoid Spark 1.3 audio limits)
    transcript = _transcript_from_history(chat_history)
    if transcript:
        try:
            data = await analyzers.client.wonder_json(
                system=(
                    "You analyze underwriting interview transcripts for audio/communication "
                    "risk signals. Return JSON only. Values are AI estimates."
                ),
                user_text=(
                    "Analyze this transcript for clarity issues, coaching/scripted answers, "
                    "third-party interference cues, and anomalies. Return JSON: status, "
                    "scores, findings, transcript_excerpt, risk_indicators. Transcript:\n"
                    f"{transcript[:12000]}"
                ),
            )
            report.audio = AudioAnalysisResult(
                status=str(data.get("status") or "review"),  # type: ignore[arg-type]
                transcript_excerpt=data.get("transcript_excerpt") or transcript[:500],
                scores={
                    k: float(v)
                    for k, v in (data.get("scores") or {}).items()
                    if isinstance(v, (int, float))
                }
                if isinstance(data.get("scores"), dict)
                else {},
                findings=[
                    Finding(**f) for f in data.get("findings") or [] if isinstance(f, dict)
                ],
                raw=data,
                disclosure=ESTIMATE_DISCLOSURE,
            )
        except Exception:
            logger.exception("audio analysis failed")
            report.audio.status = "review"
            report.audio.transcript_excerpt = transcript[:500]

    report.underwriting_outcome = _outcome_from_sections(report)
    return report


def _transcript_from_history(
    chat_history: dict[str, Any] | list[Any] | None,
) -> str:
    if not chat_history:
        return ""
    items: list[Any]
    if isinstance(chat_history, dict):
        items = chat_history.get("items") or chat_history.get("messages") or []
    else:
        items = chat_history
    lines: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or item.get("type") or "unknown"
        content = item.get("content") or item.get("text") or ""
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, str):
                    parts.append(c)
                elif isinstance(c, dict) and c.get("text"):
                    parts.append(str(c["text"]))
            content = " ".join(parts)
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines)


def _outcome_from_sections(report: UnderwritingSessionReport) -> UnderwritingOutcome:
    flags: list[str] = []
    risks: list[str] = []
    sections = [
        report.identity_liveness,
        report.face_matching,
        report.kyc,
        report.body_scan,
        report.proctoring,
        report.audio,
    ]
    fails = sum(1 for s in sections if s.status == "fail")
    reviews = sum(1 for s in sections if s.status == "review")
    if report.proctoring.status == "fail":
        flags.append("proctoring_fail")
    if report.face_matching.matched is False:
        flags.append("face_mismatch")
        risks.append("identity_mismatch")
    if report.kyc.face_match_score is not None and report.kyc.face_match_score < 0.5:
        risks.append("weak_kyc_face_match")
    for cond in report.body_scan.physical_conditions:
        risks.append(f"body:{cond}")

    if fails:
        rec = "decline_review"
    elif reviews or flags:
        rec = "manual_review"
    else:
        rec = "proceed"

    notes = (
        f"Automated recommendation based on Muse multimodal analysis. "
        f"fails={fails}, reviews={reviews}. {ESTIMATE_DISCLOSURE}"
    )
    return UnderwritingOutcome(
        recommendation=rec,  # type: ignore[arg-type]
        risk_indicators=risks[:20],
        exception_flags=flags,
        notes=notes,
        disclosure=ESTIMATE_DISCLOSURE,
    )
