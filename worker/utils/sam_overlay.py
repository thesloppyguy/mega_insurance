"""Burn SAM detection overlays onto the prepared egress clip for report preview.

Rendered frame-by-frame with PyAV + Pillow so it needs no ffmpeg ``ass`` /
``subtitles`` filter (libass is missing from many ffmpeg builds, e.g. Homebrew,
which silently produced no overlay at all).
"""

from __future__ import annotations

import logging
import os
import re
from fractions import Fraction
from pathlib import Path

logger = logging.getLogger(__name__)

_FRAME_RE = re.compile(r"<(\d+)f>")
_BOX_RE = re.compile(
    r"(\d+)<\|box;x1=([-\d.]+);y1=([-\d.]+);x2=([-\d.]+);y2=([-\d.]+);"
    r"w=([-\d.]+);h=([-\d.]+)(?:;[^|]*)?\|>"
)

# RGB colours per concept; unknown concepts fall back to white.
CONCEPT_COLORS: dict[str, tuple[int, int, int]] = {
    "person": (0, 230, 118),
    "face": (0, 200, 255),
    "id card": (255, 193, 7),
    "identity document": (255, 193, 7),
}
_FILL_ALPHA = 70
_LABEL_FONT_SIZE = 16
# How much raw SAM text (per concept) to keep for debugging the wire format.
_RAW_SAMPLE_CHARS = 6000


def parse_boxes_by_frame(raw_text: str) -> dict[int, list[tuple[int, float, float, float, float, float, float]]]:
    """
    Parse SAM special-token text into {frame: [(object_id, x1,y1,x2,y2,w,h), ...]}.
    Coordinates are source pixels from the SAM response.
    """
    out: dict[int, list[tuple[int, float, float, float, float, float, float]]] = {}
    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue
        fm = _FRAME_RE.search(line)
        if not fm:
            continue
        frame = int(fm.group(1))
        boxes: list[tuple[int, float, float, float, float, float, float]] = []
        for match in _BOX_RE.finditer(line):
            boxes.append(
                (
                    int(match.group(1)),
                    float(match.group(2)),
                    float(match.group(3)),
                    float(match.group(4)),
                    float(match.group(5)),
                    float(match.group(6)),
                    float(match.group(7)),
                )
            )
        if boxes:
            out[frame] = boxes
    return out


def _dump_raw_sample(clip_path: Path, concept_texts: dict[str, str]) -> None:
    """Save the head of each concept's raw SAM text next to the clip.

    The full text (mask tokens included) is several MB per concept, so only the
    first frame lines are kept - enough to inspect the mask encoding.
    """
    try:
        parts: list[str] = []
        for concept, text in concept_texts.items():
            lines = [ln for ln in text.splitlines() if ln.strip()][:3]
            parts.append(f"=== {concept} ({len(text)} chars) ===")
            parts.extend(ln[:_RAW_SAMPLE_CHARS] for ln in lines)
        clip_path.with_name(f"{clip_path.stem}.sam-raw-sample.txt").write_text(
            "\n".join(parts) + "\n", encoding="utf-8"
        )
    except Exception:
        logger.debug("could not write SAM raw sample", exc_info=True)


def _scaled_box(
    box: tuple[int, float, float, float, float, float, float],
    width: int,
    height: int,
) -> tuple[int, int, int, int] | None:
    _obj, x1, y1, x2, y2, src_w, src_h = box
    if src_w <= 0 or src_h <= 0:
        return None
    sx, sy = width / src_w, height / src_h
    left = max(0, int(x1 * sx))
    top = max(0, int(y1 * sy))
    right = min(width - 1, int(x2 * sx))
    bottom = min(height - 1, int(y2 * sy))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def render_sam_overlay_video(
    clip_path: Path,
    concept_rows: list[dict],
    *,
    fps: float | None = None,
    out_path: Path | None = None,
) -> Path | None:
    """
    Render a preview MP4 with SAM detections drawn on every frame.

    Returns the overlay path, or None if the clip is missing, there is no SAM
    text, or PyAV / Pillow are unavailable.
    """
    if not clip_path.is_file():
        return None
    try:
        import av
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        logger.warning("PyAV/Pillow missing; cannot render SAM overlay")
        return None

    if fps is None:
        fps = float(os.getenv("SAM_VIDEO_FPS") or "2")

    concept_texts: dict[str, str] = {}
    for row in concept_rows:
        if not isinstance(row, dict) or row.get("error"):
            continue
        concept = str(row.get("concept") or "").strip()
        raw = row.get("raw_text")
        if concept and isinstance(raw, str) and raw.strip():
            concept_texts[concept] = raw
    if not concept_texts:
        logger.info("No SAM raw text available for overlay render")
        return None

    _dump_raw_sample(clip_path, concept_texts)

    boxes_by_concept = {c: parse_boxes_by_frame(t) for c, t in concept_texts.items()}
    if not any(boxes_by_concept.values()):
        logger.info("SAM overlay has no drawable boxes")
        return None

    dest = out_path or clip_path.with_name(f"{clip_path.stem}.overlay.mp4")
    try:
        font = ImageFont.load_default(size=_LABEL_FONT_SIZE)
    except TypeError:  # very old Pillow
        font = ImageFont.load_default()

    src = out = None
    try:
        src = av.open(str(clip_path))
        in_stream = src.streams.video[0]
        width, height = in_stream.codec_context.width, in_stream.codec_context.height
        rate = in_stream.average_rate or Fraction(int(round(fps)) or 2, 1)

        out = av.open(str(dest), mode="w", options={"movflags": "+faststart"})
        out_stream = out.add_stream("libx264", rate=rate)
        out_stream.width = width - width % 2
        out_stream.height = height - height % 2
        out_stream.pix_fmt = "yuv420p"
        out_stream.options = {"crf": "26", "preset": "veryfast"}

        for index, frame in enumerate(src.decode(in_stream)):
            # SAM frame numbers index the (already fps-sampled) clip.
            if frame.pts is not None and in_stream.time_base is not None:
                frame_idx = int(round(float(frame.pts * in_stream.time_base) * fps))
            else:
                frame_idx = index

            base = frame.to_image().convert("RGBA")
            layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            for concept, frames in boxes_by_concept.items():
                color = CONCEPT_COLORS.get(concept.lower(), (255, 255, 255))
                for box in frames.get(frame_idx, ()):
                    rect = _scaled_box(box, base.width, base.height)
                    if rect is None:
                        continue
                    left, top, right, bottom = rect
                    draw.rectangle(rect, fill=(*color, _FILL_ALPHA), outline=(*color, 255), width=3)
                    label = f"{concept}:{box[0]}"
                    tw = int(draw.textlength(label, font=font))
                    ly = max(0, top - _LABEL_FONT_SIZE - 6)
                    draw.rectangle(
                        (left, ly, left + tw + 8, ly + _LABEL_FONT_SIZE + 4),
                        fill=(*color, 255),
                    )
                    draw.text((left + 4, ly + 1), label, font=font, fill=(0, 0, 0, 255))

            composed = Image.alpha_composite(base, layer).convert("RGB")
            composed = composed.crop((0, 0, out_stream.width, out_stream.height))
            out_frame = av.VideoFrame.from_image(composed)
            for packet in out_stream.encode(out_frame):
                out.mux(packet)
        for packet in out_stream.encode():
            out.mux(packet)
    except Exception:
        logger.exception("Failed to render SAM overlay video")
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        return None
    finally:
        for container in (out, src):
            try:
                if container is not None:
                    container.close()
            except Exception:
                pass

    if dest.is_file() and dest.stat().st_size > 0:
        logger.info(
            "Rendered SAM overlay preview %s (%s bytes)", dest.name, dest.stat().st_size
        )
        return dest
    return None
