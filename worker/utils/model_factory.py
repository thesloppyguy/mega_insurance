from __future__ import annotations

import logging
import os
from typing import Any

from .metadata import SessionConfig

logger = logging.getLogger(__name__)


def is_inworld_tts(config: SessionConfig) -> bool:
    tts = config.tts
    return bool(tts and (tts.provider or "").lower() == "inworld")


def build_stt(config: SessionConfig) -> Any:
    stt = config.stt
    provider = (stt.provider if stt else None) or "meta"
    model = (stt.model if stt else None) or "muse-voice-transcribe-1.0"

    if provider == "meta":
        from livekit.plugins import meta

        return meta.STT(model=model)
    if provider == "google":
        from livekit.plugins import google

        return google.STT(model=model)
    if provider == "inworld":
        from livekit.plugins import inworld

        return inworld.STT()
    raise ValueError(f"unsupported STT provider: {provider}")


def build_llm(config: SessionConfig) -> Any:
    llm = config.llm
    provider = (llm.provider if llm else None) or "google"
    model = (llm.model if llm else None) or os.getenv(
        "GOOGLE_LLM_MODEL", "gemini-2.5-flash"
    )

    if provider == "google":
        from livekit.plugins import google

        return google.LLM(model=model)
    raise ValueError(f"unsupported LLM provider: {provider}")


def build_tts(config: SessionConfig) -> Any:
    tts = config.tts
    provider = (tts.provider if tts else None) or "google"
    model = (tts.model if tts else None) or "gemini-2.5-flash-preview-tts"
    voice = (tts.voice if tts else None) or "Kore"

    if provider == "google":
        from livekit.plugins import google

        return google.TTS(model_name=model, voice_name=voice)
    if provider == "inworld":
        from livekit.plugins import inworld

        kwargs: dict[str, Any] = {}
        if voice:
            kwargs["voice"] = voice
        return inworld.TTS(**kwargs)
    raise ValueError(f"unsupported TTS provider: {provider}")
