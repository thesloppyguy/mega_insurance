from __future__ import annotations

from pathlib import Path
from typing import Any

from .metadata import BackgroundAudioConfig, ToolCallAudioConfig

_SOUNDS = Path(__file__).resolve().parent / "sounds"


def build_background_player_kwargs(
    *,
    background_audio: BackgroundAudioConfig | None,
    tool_call_audio: ToolCallAudioConfig | None = None,
) -> dict[str, Any]:
    if background_audio is None or not background_audio.enabled:
        return {}

    ambient = background_audio.ambient_path or str(_SOUNDS / "office-ambience.ogg")
    thinking = background_audio.thinking_path or str(_SOUNDS / "keyboard-typing.ogg")

    # If bundled clips are missing, skip background audio rather than crash.
    ambient_path = Path(ambient)
    thinking_path = Path(thinking)
    kwargs: dict[str, Any] = {}
    if ambient_path.exists():
        kwargs["ambient_sound"] = ambient
        kwargs["ambient_volume"] = background_audio.ambient_volume
    if thinking_path.exists():
        kwargs["thinking_sound"] = thinking
        kwargs["thinking_volume"] = background_audio.thinking_volume

    if tool_call_audio and tool_call_audio.enabled and tool_call_audio.path:
        path = Path(tool_call_audio.path)
        if path.exists():
            kwargs["tool_call_sound"] = str(path)
            kwargs["tool_call_volume"] = tool_call_audio.volume

    return kwargs
