"""Meta SAM 3.1 video segmentation for egress validation + report context."""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

META_API_BASE = os.getenv("META_API_BASE", "https://api.meta.ai/v1")

# Default underwriting concepts — one SAM request each (API rule: one noun phrase / call).
DEFAULT_CONCEPTS = ("person", "face", "id card")

_FRAME_RE = re.compile(r"<(\d+)f>")
# Object id sits immediately before each box token (after <Nf> or a comma).
_OBJECT_RE = re.compile(r"(\d+)<\|box;")


def _meta_api_key() -> str:
    return (
        os.getenv("MODEL_API_KEY") or os.getenv("META_API_KEY") or ""
    ).strip()


def _sam_model() -> str:
    return os.getenv("MUSE_SAM_MODEL", "sam-3.1").strip()


def sam_concepts() -> list[str]:
    raw = (os.getenv("MUSE_SAM_CONCEPTS") or ",".join(DEFAULT_CONCEPTS)).strip()
    concepts = [c.strip() for c in raw.split(",") if c.strip()]
    return concepts or list(DEFAULT_CONCEPTS)


async def upload_meta_file(path: Path, *, api_key: str) -> str | None:
    """Upload MP4 via Meta Files API (`purpose=user_data`). Returns `file-…` id."""
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            with path.open("rb") as fh:
                response = await client.post(
                    f"{META_API_BASE}/files",
                    headers=headers,
                    data={"purpose": "user_data"},
                    files={"file": (path.name, fh, "video/mp4")},
                )
            response.raise_for_status()
            data = response.json()
    except Exception:
        logger.exception("Meta Files upload failed for %s", path)
        return None
    file_id = data.get("id") if isinstance(data, dict) else None
    if not isinstance(file_id, str) or not file_id:
        logger.warning("Meta Files upload missing id: %s", data)
        return None
    logger.info("Uploaded egress clip to Meta file_id=%s bytes=%s", file_id, data.get("bytes"))
    return file_id


def _summarize_sam_text(text: str, *, concept: str) -> dict[str, Any]:
    """Parse SAM special-token text into validation stats (masks discarded)."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    frames_with_hits = 0
    object_ids: set[int] = set()
    max_objects_on_frame = 0
    frame_indices: list[int] = []
    for line in lines:
        fm = _FRAME_RE.search(line)
        if fm:
            frame_indices.append(int(fm.group(1)))
        ids = [int(m.group(1)) for m in _OBJECT_RE.finditer(line)]
        if not ids:
            continue
        frames_with_hits += 1
        object_ids.update(ids)
        max_objects_on_frame = max(max_objects_on_frame, len(ids))

    unique_frames = sorted(set(frame_indices))
    span = (unique_frames[-1] - unique_frames[0] + 1) if unique_frames else 0
    coverage = (
        round(frames_with_hits / span, 4) if span > 0 else (1.0 if frames_with_hits else 0.0)
    )
    return {
        "concept": concept,
        "frames_emitted": len(lines),
        "frames_with_hits": frames_with_hits,
        "frame_span": span,
        "coverage": coverage,
        "unique_object_ids": sorted(object_ids),
        "unique_object_count": len(object_ids),
        "max_objects_on_frame": max_objects_on_frame,
    }


async def _segment_video_concept(
    *,
    api_key: str,
    file_id: str,
    concept: str,
) -> dict[str, Any]:
    body = {
        "model": _sam_model(),
        "stream": True,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": concept},
                    {"type": "input_video", "file_id": file_id},
                ],
            }
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    chunks: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream(
                "POST",
                f"{META_API_BASE}/responses",
                headers=headers,
                json=body,
            ) as response:
                if response.status_code >= 400:
                    err_body = (await response.aread()).decode("utf-8", errors="replace")[:500]
                    logger.warning(
                        "SAM segment failed concept=%s status=%s body=%s",
                        concept,
                        response.status_code,
                        err_body,
                    )
                    return {
                        "concept": concept,
                        "error": f"http_{response.status_code}",
                        "detail": err_body,
                    }
                async for raw in response.aiter_lines():
                    if not raw:
                        continue
                    if raw.startswith(":"):
                        continue
                    if not raw.startswith("data:"):
                        continue
                    payload = raw[5:].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    etype = event.get("type")
                    if etype == "response.output_text.delta":
                        delta = event.get("delta")
                        if isinstance(delta, str) and delta:
                            chunks.append(delta)
                    elif etype == "response.completed":
                        # Prefer final aggregated text when present.
                        resp = event.get("response")
                        if isinstance(resp, dict):
                            out_text = resp.get("output_text")
                            if isinstance(out_text, str) and out_text.strip():
                                chunks = [out_text]
    except Exception as exc:
        logger.exception("SAM stream error concept=%s", concept)
        return {"concept": concept, "error": type(exc).__name__, "detail": str(exc)[:300]}

    text = "".join(chunks)
    summary = _summarize_sam_text(text, concept=concept)
    summary["raw_chars"] = len(text)
    # Keep wire text so we can burn box overlays for the report preview.
    # Masks make this large; callers should drop it after rendering the MP4.
    summary["raw_text"] = text
    return summary


def _validation_from_concepts(concept_rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_name = {
        str(row.get("concept")): row
        for row in concept_rows
        if isinstance(row, dict) and row.get("concept") and not row.get("error")
    }
    person = by_name.get("person") or {}
    face = by_name.get("face") or {}
    id_card = by_name.get("id card") or by_name.get("identity document") or {}

    person_coverage = float(person.get("coverage") or 0.0)
    face_coverage = float(face.get("coverage") or 0.0)
    id_frames = int(id_card.get("frames_with_hits") or 0)
    multi_person = int(person.get("max_objects_on_frame") or 0) > 1

    flags: list[str] = []
    if person_coverage < 0.5:
        flags.append("low_person_presence")
    if face_coverage < 0.2:
        flags.append("low_face_visibility")
    if multi_person:
        flags.append("multiple_persons_detected")
    if id_frames == 0:
        flags.append("id_card_not_observed")

    presence_ok = person_coverage >= 0.5
    liveness_proxy_ok = face_coverage >= 0.2 and person_coverage >= 0.5
    status = "ok" if presence_ok and not multi_person else "review"
    if flags and status == "ok":
        status = "review"

    return {
        "status": status,
        "person_coverage": person_coverage,
        "face_coverage": face_coverage,
        "id_card_frames": id_frames,
        "multiple_persons": multi_person,
        "flags": flags,
        "presence_ok": presence_ok,
        "liveness_proxy_ok": liveness_proxy_ok,
    }


async def segment_egress_video(
    video_path: Path,
    *,
    concepts: list[str] | None = None,
    render_overlay: bool = True,
) -> dict[str, Any]:
    """
    Upload egress clip once, run SAM 3.1 per concept, return validation summary.

    When ``render_overlay`` is true, also burns detection boxes onto a preview
    MP4 beside the clip (``*.overlay.mp4``) for the report UI.
    """
    api_key = _meta_api_key()
    if not api_key:
        return {
            "engine": _sam_model(),
            "skipped": True,
            "reason": "missing_api_key",
            "concepts": [],
        }
    if not video_path.is_file():
        return {
            "engine": _sam_model(),
            "skipped": True,
            "reason": "missing_video",
            "concepts": [],
        }

    file_id = await upload_meta_file(video_path, api_key=api_key)
    if not file_id:
        return {
            "engine": _sam_model(),
            "skipped": True,
            "reason": "upload_failed",
            "concepts": [],
            "source": str(video_path.name),
        }

    concept_list = concepts or sam_concepts()
    rows: list[dict[str, Any]] = []
    for concept in concept_list:
        rows.append(
            await _segment_video_concept(
                api_key=api_key, file_id=file_id, concept=concept
            )
        )

    overlay_path: Path | None = None
    if render_overlay:
        try:
            from utils.sam_overlay import render_sam_overlay_video

            overlay_path = render_sam_overlay_video(video_path, rows)
        except Exception:
            logger.exception("SAM overlay render failed")

    # Strip bulky mask text before the summary is persisted on the report.
    slim_rows: list[dict[str, Any]] = []
    for row in rows:
        slim = dict(row)
        slim.pop("raw_text", None)
        slim_rows.append(slim)

    validation = _validation_from_concepts(slim_rows)
    result: dict[str, Any] = {
        "engine": _sam_model(),
        "skipped": False,
        "source": "egress_video",
        "file_id": file_id,
        "video": video_path.name,
        "video_bytes": video_path.stat().st_size,
        "clip_path": str(video_path),
        "concepts": slim_rows,
        "validation": validation,
    }
    if overlay_path is not None:
        result["overlay_path"] = str(overlay_path)
        result["overlay_video"] = overlay_path.name
        result["overlay_bytes"] = overlay_path.stat().st_size
    return result
