from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NoiseFilteringConfig:
    enabled: bool = False
    suppression_level: float = 50.0


@dataclass
class AvatarConfig:
    provider_id: str | None = None
    external_avatar_id: str | None = None
    name: str | None = None


@dataclass
class BackgroundAudioConfig:
    enabled: bool = False
    ambient_volume: float = 0.35
    thinking_volume: float = 0.45
    ambient_path: str | None = None
    thinking_path: str | None = None


@dataclass
class ToolCallAudioConfig:
    enabled: bool = False
    path: str | None = None
    volume: float = 0.5


@dataclass
class ProviderModel:
    provider: str | None = None
    model: str | None = None
    voice: str | None = None
    output_modality: str | None = None


@dataclass
class SessionConfig:
    stt: ProviderModel | None = None
    llm: ProviderModel | None = None
    tts: ProviderModel | None = None
    realtime: ProviderModel | None = None
    avatar: AvatarConfig | None = None
    noise_filtering: NoiseFilteringConfig = field(default_factory=NoiseFilteringConfig)
    background_audio: BackgroundAudioConfig = field(default_factory=BackgroundAudioConfig)
    tool_call_audio: ToolCallAudioConfig = field(default_factory=ToolCallAudioConfig)
    instructions: str = "You are a helpful underwriting interview assistant."
    greeting: str = "Hello, welcome to your interview."


@dataclass
class SessionMetadata:
    session_id: str
    organization_id: str
    campaign_id: str | None
    recording_enabled: bool
    config: SessionConfig


@dataclass
class ToolsContext:
    backend_base_url: str
    worker_api_key: str
    session_id: str


@dataclass
class AvatarResolved:
    external_avatar_id: str | None
    provider_id: str | None
    name: str | None


@dataclass
class ProcessedDispatch:
    metadata: SessionMetadata
    tools_context: ToolsContext
    avatar: AvatarResolved
    use_avatar: bool
    use_live_pipeline: bool
    use_realtime_pipeline: bool
    dial_phone_number: str | None
    inactivity_warning_seconds: int | None
    inactivity_end_seconds: int | None
    max_duration_seconds: int | None


def _provider(raw: Any) -> ProviderModel | None:
    if not isinstance(raw, dict):
        return None
    return ProviderModel(
        provider=raw.get("provider"),
        model=raw.get("model"),
        voice=raw.get("voice"),
        output_modality=raw.get("output_modality"),
    )


def process_dispatch_metadata(raw: str | dict[str, Any] | None) -> ProcessedDispatch:
    if raw is None or raw == "":
        raise ValueError("dispatch metadata is required")
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("dispatch metadata is not valid JSON") from exc
    else:
        data = raw
    if not isinstance(data, dict):
        raise ValueError("dispatch metadata must be an object")

    cfg_raw = data.get("config") or {}
    avatar_raw = cfg_raw.get("avatar") or data.get("avatar") or {}
    noise_raw = cfg_raw.get("noise_filtering") or {}
    bg_raw = cfg_raw.get("background_audio") or {}
    tool_raw = cfg_raw.get("tool_call_audio") or {}
    tools_raw = data.get("tools_context") or {}

    session_id = str(data.get("session_id") or tools_raw.get("session_id") or "")
    organization_id = str(data.get("organization_id") or "org_local")
    if not session_id:
        raise ValueError("session_id is required in dispatch metadata")
    if not tools_raw.get("backend_base_url") or not tools_raw.get("worker_api_key"):
        raise ValueError("tools_context.backend_base_url and worker_api_key are required")

    config = SessionConfig(
        stt=_provider(cfg_raw.get("stt")),
        llm=_provider(cfg_raw.get("llm")),
        tts=_provider(cfg_raw.get("tts")),
        realtime=_provider(cfg_raw.get("realtime")),
        avatar=AvatarConfig(
            provider_id=avatar_raw.get("provider_id"),
            external_avatar_id=avatar_raw.get("external_avatar_id"),
            name=avatar_raw.get("name"),
        ),
        noise_filtering=NoiseFilteringConfig(
            enabled=bool(noise_raw.get("enabled", False)),
            suppression_level=float(noise_raw.get("suppression_level", 50)),
        ),
        background_audio=BackgroundAudioConfig(
            enabled=bool(bg_raw.get("enabled", False)),
            ambient_volume=float(bg_raw.get("ambient_volume", 0.35)),
            thinking_volume=float(bg_raw.get("thinking_volume", 0.45)),
            ambient_path=bg_raw.get("ambient_path"),
            thinking_path=bg_raw.get("thinking_path"),
        ),
        tool_call_audio=ToolCallAudioConfig(
            enabled=bool(tool_raw.get("enabled", False)),
            path=tool_raw.get("path"),
            volume=float(tool_raw.get("volume", 0.5)),
        ),
        instructions=str(cfg_raw.get("instructions") or SessionConfig.instructions),
        greeting=str(cfg_raw.get("greeting") or SessionConfig.greeting),
    )

    metadata = SessionMetadata(
        session_id=session_id,
        organization_id=organization_id,
        campaign_id=data.get("campaign_id"),
        recording_enabled=bool(data.get("recording_enabled", True)),
        config=config,
    )
    tools = ToolsContext(
        backend_base_url=str(tools_raw["backend_base_url"]).rstrip("/"),
        worker_api_key=str(tools_raw["worker_api_key"]),
        session_id=session_id,
    )
    avatar = AvatarResolved(
        external_avatar_id=avatar_raw.get("external_avatar_id"),
        provider_id=avatar_raw.get("provider_id"),
        name=avatar_raw.get("name"),
    )
    use_realtime = config.realtime is not None and bool(config.realtime.provider)
    return ProcessedDispatch(
        metadata=metadata,
        tools_context=tools,
        avatar=avatar,
        use_avatar=bool(data.get("use_avatar", False)) and bool(avatar.external_avatar_id),
        use_live_pipeline=False,
        use_realtime_pipeline=use_realtime,
        dial_phone_number=data.get("dial_phone_number"),
        inactivity_warning_seconds=data.get("inactivity_warning_seconds"),
        inactivity_end_seconds=data.get("inactivity_end_seconds"),
        max_duration_seconds=data.get("max_duration_seconds"),
    )
