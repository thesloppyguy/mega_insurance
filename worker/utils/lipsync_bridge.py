"""Forward Inworld IPA phoneticDetails to the browser over LiveKit data.

The Inworld LiveKit plugin receives ``timestampInfo.wordAlignment.phoneticDetails``
but only pushes word-level ``TimedString``s. This bridge monkeypatches
``_parse_timestamp_info`` so we can tap the IPA phones and publish:

* ``avatar.lipsync`` (JSON) turn markers: ``turn_start`` (frames may follow,
  usually ahead of the audio), ``audio_start`` (the first audio frame of the
  turn is being played out *now* — the client's sync anchor) and ``turn_end``.
  Raw phones are only sent when ``send_phonemes`` is enabled.
* ``avatar.flame`` (binary, see :mod:`utils.flame.wire`): FLAME keyframes
  generated here in the worker, so the browser only has to play them back.

Frame ``i`` is shown ``i / fps`` seconds after ``audio_start``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from livekit import rtc
from livekit.agents import AgentSession
from livekit.agents.voice.events import AgentStateChangedEvent
from livekit.plugins.inworld import tts as inworld_tts

from utils.flame import FLAME_TOPIC, FlameStream, encode_packets

logger = logging.getLogger(__name__)

LIPSYNC_TOPIC = "avatar.lipsync"
# Phonemes can precede the ``speaking`` state flip; a turn opened by them
# within this window is the same turn the flip announces.
_EARLY_TURN_WINDOW_S = 3.0

_original_parse = inworld_tts._parse_timestamp_info
_phoneme_sink: Callable[[list[dict[str, Any]], float], None] | None = None
_patched = False


def _offset_phonetic_details(
    details: list[dict[str, Any]], cumulative_time: float
) -> list[dict[str, Any]]:
    if cumulative_time == 0:
        return details
    out: list[dict[str, Any]] = []
    for detail in details:
        phones_out: list[dict[str, Any]] = []
        for phone in detail.get("phones") or []:
            start = float(phone.get("startTimeSeconds") or 0)
            phones_out.append({**phone, "startTimeSeconds": start + cumulative_time})
        out.append({**detail, "phones": phones_out})
    return out


def _patched_parse_timestamp_info(
    timestamp_info: dict[str, Any], cumulative_time: float = 0.0
) -> Any:
    word_align = timestamp_info.get("wordAlignment") or {}
    details = word_align.get("phoneticDetails")
    if details and _phoneme_sink is not None:
        try:
            _phoneme_sink(
                _offset_phonetic_details(list(details), cumulative_time),
                cumulative_time,
            )
        except Exception:
            logger.exception("lipsync phoneme sink failed")
    return _original_parse(timestamp_info, cumulative_time)


def _ensure_patch() -> None:
    global _patched
    if _patched:
        return
    inworld_tts._parse_timestamp_info = _patched_parse_timestamp_info
    _patched = True


class LipsyncBridge:
    """Publish turn markers, phonemes and server-generated FLAME frames."""

    def __init__(
        self,
        room: rtc.Room,
        *,
        send_flames: bool = True,
        send_phonemes: bool = False,
    ) -> None:
        self._room = room
        self._send_flames = send_flames
        self._send_phonemes = send_phonemes
        self._turn_id: str | None = None
        self._turn_opened_at = 0.0
        self._flames: FlameStream | None = None
        self._lock = threading.Lock()
        self._loop = asyncio.get_running_loop()
        _ensure_patch()

    def attach(self, session: AgentSession) -> None:
        global _phoneme_sink
        _phoneme_sink = self._on_phonemes
        session.on("agent_state_changed", self._on_agent_state)

    def detach(self, session: AgentSession) -> None:
        global _phoneme_sink
        session.off("agent_state_changed", self._on_agent_state)
        with self._lock:
            self._end_turn_locked()
        if _phoneme_sink is self._on_phonemes:
            _phoneme_sink = None

    def _on_agent_state(self, ev: AgentStateChangedEvent) -> None:
        with self._lock:
            if ev.new_state == "speaking" and ev.old_state != "speaking":
                early = (
                    self._turn_id is not None
                    and time.monotonic() - self._turn_opened_at
                    < _EARLY_TURN_WINDOW_S
                )
                if not early:
                    self._start_turn_locked()
                # The agent state flips when the first audio frame is played
                # out, so this is the moment frame 0 should be shown.
                self._publish({"type": "audio_start", "turn_id": self._turn_id})
            elif ev.old_state == "speaking" and ev.new_state != "speaking":
                self._end_turn_locked()

    def _start_turn_locked(self) -> None:
        # A stale turn that never ended must not leak frames into the new one.
        self._end_turn_locked()
        self._turn_id = uuid.uuid4().hex[:12]
        self._turn_opened_at = time.monotonic()
        self._flames = FlameStream() if self._send_flames else None
        self._publish({"type": "turn_start", "turn_id": self._turn_id})

    def _end_turn_locked(self) -> None:
        turn_id, flames = self._turn_id, self._flames
        self._turn_id = None
        self._flames = None
        if not turn_id:
            return
        if flames is not None:
            self._publish_flames(turn_id, flames, finish=True)
        self._publish({"type": "turn_end", "turn_id": turn_id})

    def _on_phonemes(
        self, phonetic_details: list[dict[str, Any]], offset: float
    ) -> None:
        if not phonetic_details:
            return
        with self._lock:
            if self._turn_id is None:
                # Phonemes can arrive slightly before the speaking state flip.
                self._start_turn_locked()
            turn_id = self._turn_id
            assert turn_id is not None
            if self._send_phonemes:
                self._publish(
                    {
                        "type": "phonemes",
                        "turn_id": turn_id,
                        "phoneticDetails": phonetic_details,
                        "offset": offset,
                    }
                )
            if self._flames is not None:
                self._publish_flames(
                    turn_id, self._flames, details=phonetic_details
                )

    def _publish_flames(
        self,
        turn_id: str,
        stream: FlameStream,
        *,
        details: list[dict[str, Any]] | None = None,
        finish: bool = False,
    ) -> None:
        try:
            start, frames = (
                stream.finish()
                if finish
                else stream.add_phonemes(details or [])
            )
            for packet in encode_packets(
                turn_id, start, frames, stream.fps, final=finish
            ):
                self._publish_bytes(packet, FLAME_TOPIC)
        except Exception:
            logger.exception("flame generation failed")

    def _publish(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, separators=(",", ":"))
        self._spawn(self._publish_async(data, LIPSYNC_TOPIC))

    def _publish_bytes(self, data: bytes, topic: str) -> None:
        self._spawn(self._publish_async(data, topic))

    def _spawn(self, coro: Any) -> None:
        try:
            asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            asyncio.run_coroutine_threadsafe(coro, self._loop)

    async def _publish_async(self, data: str | bytes, topic: str) -> None:
        try:
            await self._room.local_participant.publish_data(
                data, reliable=True, topic=topic
            )
        except Exception:
            logger.exception("failed to publish %s packet", topic)
