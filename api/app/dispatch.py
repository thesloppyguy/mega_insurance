from __future__ import annotations

import os
from typing import Any

from .config import (
    ANAM_AVATAR_ID,
    ANAM_AVATAR_NAME,
    API_PUBLIC_BASE_URL,
    WORKER_API_KEY,
)


def build_agent_dispatch_metadata(session: dict[str, Any]) -> dict[str, Any]:
    """Metadata shape expected by worker.utils.metadata.process_dispatch_metadata."""
    cfg = session.get("config") or {}
    avatar_id = cfg.get("anam_avatar_id") or ANAM_AVATAR_ID
    avatar_name = cfg.get("anam_avatar_name") or ANAM_AVATAR_NAME
    use_avatar = bool(avatar_id) and cfg.get("use_avatar", True)

    return {
        "session_id": session["session_id"],
        "organization_id": session["organization_id"],
        "campaign_id": session.get("campaign_id"),
        "recording_enabled": cfg.get("recording_enabled", True),
        "use_avatar": use_avatar,
        "max_duration_seconds": cfg.get("max_duration_seconds", 1800),
        "inactivity_warning_seconds": cfg.get("inactivity_warning_seconds", 45),
        "inactivity_end_seconds": cfg.get("inactivity_end_seconds", 120),
        "dial_phone_number": None,
        "tools_context": {
            "backend_base_url": API_PUBLIC_BASE_URL,
            "worker_api_key": WORKER_API_KEY,
            "session_id": session["session_id"],
        },
        "avatar": {
            "provider_id": "anam" if use_avatar else None,
            "external_avatar_id": avatar_id or None,
            "name": avatar_name,
        },
        "config": {
            "stt": {
                "provider": "meta",
                "model": "muse-voice-transcribe-1.0",
            },
            "llm": {
                "provider": "google",
                "model": os.getenv("GOOGLE_LLM_MODEL", "gemini-2.5-flash"),
            },
            "tts": {
                "provider": os.getenv("TTS_PROVIDER", "google"),
                "model": os.getenv("TTS_MODEL", "gemini-2.5-flash-preview-tts"),
                "voice": os.getenv("TTS_VOICE", "Kore"),
            },
            "realtime": None,
            "avatar": {
                "provider_id": "anam" if use_avatar else None,
                "external_avatar_id": avatar_id or None,
                "name": avatar_name,
            },
            "noise_filtering": {
                "enabled": False,
                "suppression_level": 50,
            },
            "background_audio": {
                "enabled": cfg.get("background_audio_enabled", True),
                "ambient_volume": float(cfg.get("ambient_volume", 0.35)),
                "thinking_volume": float(cfg.get("thinking_volume", 0.45)),
            },
            "tool_call_audio": {
                "enabled": False,
            },
            "instructions": cfg.get(
                "instructions",
                (
                    "You are Mavrik, a professional insurance underwriting interview assistant. "
                    "Guide the customer through lighting check, face capture, liveness, KYC "
                    "document scan, and full-body front then back capture. Speak clearly, "
                    "one step at a time. Never invent medical diagnoses. When estimates are "
                    "shared, disclose they are AI estimates only, not clinical measurements."
                ),
            ),
            "greeting": cfg.get(
                "greeting",
                "Hello, and welcome. I am Mavrik, your underwriting interview assistant. "
                "We will verify your identity and complete a guided body scan. Are you ready to begin?",
            ),
        },
    }
