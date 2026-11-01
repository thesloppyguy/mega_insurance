from __future__ import annotations

import base64
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

ESTIMATE_DISCLOSURE = (
    "These values are AI estimates derived from video/images only. They are not "
    "clinical measurements, medical advice, or a diagnosis."
)


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {"value": data}
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                data = json.loads(match.group(0))
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError:
                pass
        return {"raw_text": text}


class MuseClient:
    """Thin Meta Model API client for Muse Spark / Wonder / SAM."""

    def __init__(self, api_key: str | None = None) -> None:
        key = api_key or os.getenv("MODEL_API_KEY") or os.getenv("META_API_KEY")
        if not key:
            logger.warning("MODEL_API_KEY not set; Muse calls will fail until configured")
        self.client = AsyncOpenAI(
            base_url="https://api.meta.ai/v1",
            api_key=key or "missing",
        )
        self.spark_model = os.getenv("MUSE_SPARK_MODEL", "muse-spark-1.3")
        self.wonder_model = os.getenv("MUSE_WONDER_MODEL", "muse-wonder-1.0")
        self.sam_model = os.getenv("MUSE_SAM_MODEL", "sam-3.1")

    @staticmethod
    def image_part_from_bytes(content: bytes, mime: str = "image/jpeg") -> dict[str, Any]:
        b64 = base64.b64encode(content).decode("ascii")
        return {
            "type": "input_image",
            "image_url": f"data:{mime};base64,{b64}",
        }

    @staticmethod
    def image_part_from_path(path: str | Path) -> dict[str, Any]:
        p = Path(path)
        content = p.read_bytes()
        suffix = p.suffix.lower()
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }.get(suffix, "image/jpeg")
        return MuseClient.image_part_from_bytes(content, mime)

    async def respond_json(
        self,
        *,
        model: str,
        system: str,
        user_text: str,
        images: list[dict[str, Any]] | None = None,
        reasoning_effort: str | None = "low",
    ) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "input_text", "text": user_text}]
        if images:
            content.extend(images)

        kwargs: dict[str, Any] = {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system}],
                },
                {"role": "user", "content": content},
            ],
        }
        if reasoning_effort:
            kwargs["reasoning"] = {"effort": reasoning_effort}

        try:
            resp = await self.client.responses.create(**kwargs)
        except Exception:
            logger.exception("Muse responses.create failed model=%s", model)
            # Fallback to chat.completions for broader compatibility.
            try:
                chat_content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
                for img in images or []:
                    url = img.get("image_url")
                    if url:
                        chat_content.append({"type": "image_url", "image_url": {"url": url}})
                chat = await self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": chat_content},
                    ],
                    response_format={"type": "json_object"},
                )
                text = chat.choices[0].message.content or "{}"
                return _extract_json(text)
            except Exception:
                logger.exception("Muse chat.completions fallback failed model=%s", model)
                return {"error": "muse_call_failed", "model": model}

        text = getattr(resp, "output_text", None)
        if not text:
            # Best-effort walk of response output items.
            chunks: list[str] = []
            for item in getattr(resp, "output", None) or []:
                for part in getattr(item, "content", None) or []:
                    t = getattr(part, "text", None)
                    if t:
                        chunks.append(t)
            text = "\n".join(chunks) if chunks else "{}"
        return _extract_json(text)

    async def spark_json(
        self,
        *,
        system: str,
        user_text: str,
        images: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.respond_json(
            model=self.spark_model,
            system=system,
            user_text=user_text,
            images=images,
            reasoning_effort="low",
        )

    async def wonder_json(
        self,
        *,
        system: str,
        user_text: str,
        images: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.respond_json(
            model=self.wonder_model,
            system=system,
            user_text=user_text,
            images=images,
            reasoning_effort="medium",
        )

    async def segment(
        self,
        *,
        prompt: str,
        image: dict[str, Any],
    ) -> dict[str, Any]:
        """Call SAM 3.1 for geometry; returns boxes/masks when available."""
        system = (
            "You are Segment Anything. Return JSON with keys: objects (list of "
            "{label, box_xyxy, score}). box_xyxy is [x0,y0,x1,y1] normalized 0-1."
        )
        return await self.respond_json(
            model=self.sam_model,
            system=system,
            user_text=prompt,
            images=[image],
            reasoning_effort=None,
        )
