from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any, Callable, Awaitable

from livekit import rtc

from .analyzers import MuseAnalyzers
from .backend_client import BackendClient
from .schemas import ProctorEvent, ProctoringResult

logger = logging.getLogger(__name__)


class LiveProctor:
    """Samples user video periodically and runs Muse Spark + SAM checks."""

    def __init__(
        self,
        *,
        room: rtc.Room,
        backend: BackendClient,
        session_id: str,
        analyzers: MuseAnalyzers | None = None,
        interval_s: float = 2.5,
        on_high_severity: Callable[[ProctorEvent], Awaitable[None]] | None = None,
    ) -> None:
        self.room = room
        self.backend = backend
        self.session_id = session_id
        self.analyzers = analyzers or MuseAnalyzers()
        self.interval_s = interval_s
        self.on_high_severity = on_high_severity
        self.timeline: list[ProctorEvent] = []
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._latest_frame: rtc.VideoFrame | None = None
        self._video_stream: rtc.VideoStream | None = None
        self._reader_task: asyncio.Task[None] | None = None

    def start(self, user_identity: str | None) -> None:
        self._attach_video(user_identity)
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> ProctoringResult:
        self._stop.set()
        if self._task:
            try:
                await self._task
            except Exception:
                logger.exception("proctor loop shutdown error")
        if self._reader_task:
            self._reader_task.cancel()
        if self._video_stream is not None:
            await self._video_stream.aclose()
            self._video_stream = None
        return await self.analyzers.summarize_proctoring(self.timeline)

    def ingest_client_signal(self, detail: dict[str, Any]) -> ProctorEvent:
        event = ProctorEvent(
            at=str(time.time()),
            face_count=detail.get("face_count"),
            looking_away=detail.get("looking_away"),
            device_detected=detail.get("device_detected"),
            extra_person=detail.get("extra_person"),
            severity=detail.get("severity")
            if detail.get("severity") in ("info", "low", "medium", "high")
            else "info",
            message=str(detail.get("message") or "client_proctor_signal"),
        )
        self.timeline.append(event)
        asyncio.create_task(
            self.backend.create_session_event(
                self.session_id,
                event_type="proctor_client",
                actor="FRONTEND",
                payload=event.model_dump(),
            )
        )
        return event

    def _attach_video(self, user_identity: str | None) -> None:
        participant = None
        if user_identity:
            participant = self.room.remote_participants.get(user_identity)
        if participant is None and self.room.remote_participants:
            participant = next(iter(self.room.remote_participants.values()))
        if participant is None:
            logger.warning("proctor: no participant for video attach")
            return

        for pub in participant.track_publications.values():
            track = pub.track
            if track and pub.kind == rtc.TrackKind.KIND_VIDEO:
                self._create_stream(track)
                break

        @self.room.on("track_subscribed")
        def _on_sub(
            track: rtc.Track,
            publication: rtc.RemoteTrackPublication,
            participant: rtc.RemoteParticipant,
        ) -> None:
            if user_identity and participant.identity != user_identity:
                return
            if track.kind == rtc.TrackKind.KIND_VIDEO:
                self._create_stream(track)

    def _create_stream(self, track: rtc.Track) -> None:
        if self._video_stream is not None:
            asyncio.create_task(self._video_stream.aclose())
        self._video_stream = rtc.VideoStream(track)

        async def _read() -> None:
            assert self._video_stream is not None
            async for event in self._video_stream:
                self._latest_frame = event.frame

        self._reader_task = asyncio.create_task(_read())

    async def _loop(self) -> None:
        from livekit.agents.utils.images import EncodeOptions, encode

        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval_s)
                break
            except TimeoutError:
                pass
            frame = self._latest_frame
            if frame is None:
                continue
            try:
                jpeg = encode(frame, EncodeOptions(format="JPEG"))
                event = await self.analyzers.proctor_frame(jpeg)
                event.at = str(time.time())
                self.timeline.append(event)
                await self.backend.create_session_event(
                    self.session_id,
                    event_type="proctor_sample",
                    payload=event.model_dump(),
                )
                if event.severity in ("high", "medium") and self.on_high_severity:
                    await self.on_high_severity(event)
            except Exception:
                logger.exception("proctor sample failed")

    @staticmethod
    def decode_data_url(data_url: str) -> bytes:
        b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
        return base64.b64decode(b64)
