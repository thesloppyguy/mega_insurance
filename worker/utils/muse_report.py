"""Post-call underwriting report via Meta Muse Wonder + SAM 3.1 on egress video."""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

META_API_BASE = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
DISCLOSURE = (
    "These values are AI estimates derived from video/images only. "
    "They are not clinical measurements, medical advice, or a diagnosis."
)


def _meta_api_key() -> str:
    return (
        os.getenv("MODEL_API_KEY")
        or os.getenv("META_API_KEY")
        or ""
    ).strip()


def _wonder_model() -> str:
    return os.getenv("MUSE_WONDER_MODEL", "muse-wonder-1.0").strip()


def _sam_model() -> str:
    return os.getenv("MUSE_SAM_MODEL", "sam-3.1").strip()


def _transcript_excerpt(history: Any, *, limit: int = 4000) -> str:
    if not history:
        return ""
    items = history.get("items") if isinstance(history, dict) else None
    if not isinstance(items, list):
        try:
            return json.dumps(history, ensure_ascii=False)[:limit]
        except Exception:
            return str(history)[:limit]
    lines: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or item.get("type") or "unknown"
        content = item.get("content") or item.get("text") or ""
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and part.get("text"):
                    parts.append(str(part["text"]))
            content = " ".join(parts)
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines)[:limit]


def _collect_image_paths(session_data: dict[str, Any]) -> list[Path]:
    assets = session_data.get("assets") or []
    paths: list[Path] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        for key in ("path", "filepath", "local_path", "file_path"):
            raw = asset.get(key)
            if isinstance(raw, str) and raw.strip():
                p = Path(raw)
                if p.is_file():
                    paths.append(p)
                    break
    return paths[:8]


def _image_data_url(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    mime = "image/jpeg"
    if path.suffix.lower() == ".png":
        mime = "image/png"
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


async def _call_muse_wonder(
    *,
    prompt: str,
    image_paths: list[Path],
) -> dict[str, Any] | None:
    api_key = _meta_api_key()
    if not api_key:
        logger.warning("Skipping Muse report: MODEL_API_KEY / META_API_KEY missing")
        return None

    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    for path in image_paths:
        url = _image_data_url(path)
        if url:
            content.append({"type": "input_image", "image_url": url})

    body = {
        "model": _wonder_model(),
        "input": [{"role": "user", "content": content}],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            # Prefer Responses API shape used by Meta Model API.
            response = await client.post(
                f"{META_API_BASE}/responses",
                headers=headers,
                json=body,
            )
            if response.status_code >= 400:
                # Fallback: chat completions
                chat_body = {
                    "model": _wonder_model(),
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                *[
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": u},
                                    }
                                    for p in image_paths
                                    if (u := _image_data_url(p))
                                ],
                            ],
                        }
                    ],
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                }
                response = await client.post(
                    f"{META_API_BASE}/chat/completions",
                    headers=headers,
                    json=chat_body,
                )
            response.raise_for_status()
            data = response.json()
    except Exception:
        logger.exception("Muse Wonder request failed")
        return None

    text = _extract_text(data)
    if not text:
        return None
    try:
        # Strip markdown fences if present
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
        return json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("Muse Wonder returned non-JSON: %s", text[:300])
        return {"raw_text": text}


def _extract_text(data: dict[str, Any]) -> str:
    # Responses API
    output = data.get("output")
    if isinstance(output, list):
        chunks: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("text"):
                        chunks.append(str(part["text"]))
            elif isinstance(content, str):
                chunks.append(content)
        if chunks:
            return "\n".join(chunks)
    # Chat completions
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(msg, dict) and msg.get("content"):
            return str(msg["content"])
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    return ""


async def _persist_sam_videos(
    session_id: str,
    sam: dict[str, Any],
) -> dict[str, Any]:
    """Upload SAM clip + overlay preview as session assets for the report UI."""
    if not session_id:
        return sam
    from utils.backend_client import backend_from_env

    backend = backend_from_env()
    clip_path = sam.get("clip_path")
    overlay_path = sam.get("overlay_path")

    if isinstance(clip_path, str) and clip_path:
        asset = await backend.upload_session_asset(
            session_id,
            kind="sam_clip",
            path=clip_path,
            filename="sam-clip.mp4",
            meta={"role": "sam_clip", "source": sam.get("source")},
        )
        if asset and asset.get("asset_id"):
            sam["clip_asset_id"] = asset["asset_id"]

    if isinstance(overlay_path, str) and overlay_path:
        asset = await backend.upload_session_asset(
            session_id,
            kind="sam_overlay",
            path=overlay_path,
            filename="sam-overlay.mp4",
            meta={"role": "sam_overlay", "source": sam.get("source")},
        )
        if asset and asset.get("asset_id"):
            sam["overlay_asset_id"] = asset["asset_id"]

    # Drop local temp paths from the persisted report payload.
    sam.pop("clip_path", None)
    sam.pop("overlay_path", None)
    return sam


async def _run_sam_on_egress(
    session_data: dict[str, Any],
    *,
    session_id: str = "",
) -> dict[str, Any]:
    """Download room-composite egress MP4, downsample, run SAM 3.1 concepts."""
    from utils.egress_media import (
        pick_egress_filepath,
        prepare_sam_clip,
        wait_and_download_egress,
    )
    from utils.sam_segment import segment_egress_video

    filepath = pick_egress_filepath(session_data)
    if not filepath:
        return {
            "engine": _sam_model(),
            "skipped": True,
            "reason": "no_egress_filepath",
            "concepts": [],
        }

    work_dir: Path | None = None
    try:
        local = await wait_and_download_egress(filepath)
        if local is None:
            return {
                "engine": _sam_model(),
                "skipped": True,
                "reason": "egress_download_failed",
                "egress_filepath": filepath,
                "concepts": [],
            }
        work_dir = local.parent
        clip = prepare_sam_clip(local)
        sam = await segment_egress_video(clip)
        return await _persist_sam_videos(session_id, sam)
    except Exception:
        logger.exception("SAM egress pipeline failed")
        return {
            "engine": _sam_model(),
            "skipped": True,
            "reason": "sam_pipeline_error",
            "egress_filepath": filepath,
            "concepts": [],
        }
    finally:
        if work_dir and work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)


def _map_to_underwriting_report(
    *,
    session_id: str,
    muse: dict[str, Any],
    sam: dict[str, Any],
) -> dict[str, Any]:
    vitals = muse.get("vitals") if isinstance(muse.get("vitals"), dict) else {}
    physical = (
        muse.get("physicalCondition")
        if isinstance(muse.get("physicalCondition"), dict)
        else {}
    )
    underwriting = (
        muse.get("underwriting") if isinstance(muse.get("underwriting"), dict) else {}
    )
    id_capture = muse.get("idCapture") if isinstance(muse.get("idCapture"), dict) else {}
    validation = sam.get("validation") if isinstance(sam.get("validation"), dict) else {}

    estimates = {
        "height_cm": vitals.get("heightCm"),
        "weight_kg": vitals.get("weightKg"),
        "bmi": vitals.get("bmi"),
        "heart_rate_bpm": vitals.get("heartRateBpm"),
        "respiratory_rate_bpm": vitals.get("respiratoryRate"),
        "fitness_assessment": vitals.get("fitnessAssessment"),
    }
    conditions: list[str] = []
    for key in (
        "impairments",
        "mobilityLimitations",
        "assistiveDevices",
        "otherFindings",
    ):
        vals = physical.get(key)
        if isinstance(vals, list):
            conditions.extend(str(v) for v in vals)
    if physical.get("postureNotes"):
        conditions.append(str(physical["postureNotes"]))

    recommendation = "review"
    if underwriting.get("underwriterReviewRecommended") is False:
        recommendation = "clear"
    elif underwriting.get("underwriterReviewRecommended") is True:
        recommendation = "refer"

    risk_indicators = list(underwriting.get("riskIndicators") or [])
    exception_flags = list(underwriting.get("exceptionFlags") or [])
    for flag in validation.get("flags") or []:
        if flag not in exception_flags:
            exception_flags.append(str(flag))
    if validation.get("multiple_persons") and "multiple_persons_detected" not in risk_indicators:
        risk_indicators.append("multiple_persons_detected")
    if validation.get("status") == "review" and recommendation == "clear":
        recommendation = "review"

    identity_status = (
        underwriting.get("identityStatus")
        or underwriting.get("livenessStatus")
        or "pending"
    )
    if validation.get("liveness_proxy_ok") and identity_status == "pending":
        identity_status = "ok"
    elif validation.get("flags") and identity_status == "ok":
        identity_status = "review"

    proctoring_bits = [str(x) for x in (muse.get("proctoringNotes") or [])]
    if validation:
        proctoring_bits.append(
            "SAM egress: person_coverage="
            f"{validation.get('person_coverage')} face_coverage="
            f"{validation.get('face_coverage')} id_frames="
            f"{validation.get('id_card_frames')} flags="
            f"{','.join(validation.get('flags') or []) or 'none'}"
        )

    kyc_status = "ok" if id_capture.get("readable") else "pending"
    if validation.get("id_card_frames", 0) > 0 and kyc_status == "pending":
        kyc_status = "ok"

    return {
        "session_id": session_id,
        "disclosure": DISCLOSURE,
        "engine": {
            "wonder": _wonder_model(),
            "sam": sam.get("engine") or _sam_model(),
            "sam_source": sam.get("source") or sam.get("reason"),
        },
        "identity_liveness": {
            "status": identity_status,
            "findings": [],
            "sam_person_coverage": validation.get("person_coverage"),
            "sam_face_coverage": validation.get("face_coverage"),
        },
        "kyc": {
            "status": kyc_status,
            "document_type": id_capture.get("documentType"),
            "extracted_fields": {
                "name_visible": id_capture.get("nameVisible"),
                "photo_visible": id_capture.get("photoVisible"),
            },
            "sam_id_card_frames": validation.get("id_card_frames"),
        },
        "body_scan": {
            "status": "ok" if any(estimates.values()) else "pending",
            "view": "mixed",
            "physical_conditions": conditions,
            "estimates": estimates,
            "disclosure": DISCLOSURE,
        },
        "proctoring": {
            "status": validation.get("status") or "ok",
            "summary": "; ".join(proctoring_bits),
            "timeline": [],
            "sam_validation": validation or None,
        },
        "underwriting_outcome": {
            "recommendation": recommendation,
            "risk_indicators": risk_indicators,
            "exception_flags": exception_flags,
            "notes": underwriting.get("summary") or "",
            "disclosure": DISCLOSURE,
        },
        "sam_summary": sam,
        "raw_muse": muse,
    }


async def build_underwriting_report(
    *,
    session_id: str,
    session_data: dict[str, Any],
    history: Any = None,
) -> dict[str, Any] | None:
    if not session_id:
        return None

    image_paths = _collect_image_paths(session_data)
    # Also try mavrik data dir convention
    data_root = Path(os.getenv("MAVRIK_DATA_DIR", "") or "")
    if data_root.is_dir():
        session_dir = data_root / "sessions" / session_id
        if session_dir.is_dir():
            for pattern in ("*.jpg", "*.jpeg", "*.png"):
                image_paths.extend(sorted(session_dir.glob(pattern))[:4])
        assets_dir = data_root / "assets" / session_id
        if assets_dir.is_dir():
            for pattern in ("*.jpg", "*.jpeg", "*.png"):
                image_paths.extend(sorted(assets_dir.glob(pattern))[:8])
    # Dedupe
    seen: set[str] = set()
    unique_paths: list[Path] = []
    for p in image_paths:
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        unique_paths.append(p)

    sam = await _run_sam_on_egress(session_data, session_id=session_id)
    transcript = _transcript_excerpt(history)
    prompt = (
        "You are assisting insurance underwriting with a best-effort VISUAL ESTIMATE "
        "from session stills, egress-video SAM segmentation, and transcript. "
        "NOT clinical measurements. Return JSON only: "
        '{"vitals":{"heightCm":number,"weightKg":number,"bmi":number,"heartRateBpm":number,'
        '"respiratoryRate":number,"fitnessAssessment":string},'
        '"physicalCondition":{"impairments":string[],"mobilityLimitations":string[],'
        '"postureNotes":string,"assistiveDevices":string[],"otherFindings":string[]},'
        '"underwriting":{"identityStatus":string,"livenessStatus":string,'
        '"riskIndicators":string[],"exceptionFlags":string[],'
        '"underwriterReviewRecommended":boolean,"summary":string},'
        '"videoUnavailable":false,"detectedObjects":string[],"proctoringNotes":string[],'
        '"idCapture":{"documentType":string,"nameVisible":boolean,"photoVisible":boolean,'
        '"readable":boolean,"redactedNote":string}}. '
        "Never include full government ID numbers. "
        "Use the SAM egress validation stats as ground truth for presence / multi-person / "
        "id-card observation; prefer review when SAM flags issues. "
        f"SAM egress summary: {json.dumps(sam)[:3500]}\n"
        f"Transcript excerpt:\n{transcript[:3000]}"
    )

    muse = await _call_muse_wonder(prompt=prompt, image_paths=unique_paths[:6])
    if muse is None:
        return {
            "session_id": session_id,
            "disclosure": DISCLOSURE,
            "engine": {
                "wonder": _wonder_model(),
                "sam": sam.get("engine") or _sam_model(),
                "sam_source": sam.get("source") or sam.get("reason"),
            },
            "underwriting_outcome": {
                "recommendation": "pending",
                "notes": "Muse analysis unavailable (missing API key or request failed).",
                "risk_indicators": [],
                "exception_flags": list((sam.get("validation") or {}).get("flags") or []),
                "disclosure": DISCLOSURE,
            },
            "body_scan": {"status": "pending", "estimates": {}, "physical_conditions": []},
            "identity_liveness": {
                "status": "review" if sam.get("validation") else "pending",
                "sam_person_coverage": (sam.get("validation") or {}).get("person_coverage"),
                "sam_face_coverage": (sam.get("validation") or {}).get("face_coverage"),
            },
            "proctoring": {
                "status": (sam.get("validation") or {}).get("status") or "pending",
                "summary": "SAM-only (Wonder unavailable)",
                "sam_validation": sam.get("validation"),
            },
            "sam_summary": sam,
        }

    return _map_to_underwriting_report(
        session_id=session_id, muse=muse, sam=sam
    )
