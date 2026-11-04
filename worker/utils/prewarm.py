"""Process-level prewarm for mavrik agent jobs.

Runs via ``AgentServer.setup_fnc`` in each idle job process *before* a room is
assigned, so first-turn latency does not pay for:

* FLAME / lipsync asset parse
* STT / LLM / TTS object construction
* DNS lookup for Inworld + Meta
* aiohttp SSL context build
* late imports used on session end (report / SAM / egress)

Connection-level warm (LLM HTTP keep-alive, Inworld TTS WebSocket) needs a
running event loop — call :func:`warm_pipeline_connections` at the start of the
job entrypoint (http context is already bound by then).
"""

from __future__ import annotations

import logging
import os
import socket
import time
from typing import Any
from urllib.parse import urlparse

from livekit.agents import JobProcess
from livekit.plugins import inworld, meta

from utils.inworld_llm import (
    INWORLD_INFERENCE_BASE_URL,
    INWORLD_LIST_MODELS_URL,
    build_inworld_llm,
)

logger = logging.getLogger(__name__)

INWORLD_TTS_VOICE = os.getenv("INWORLD_TTS_VOICE", "Aarav")
INWORLD_TTS_MODEL = os.getenv("INWORLD_TTS_MODEL", "inworld-tts-2-flash")
META_STT_MODEL = "muse-voice-transcribe-1.0"

_USERDATA_STT = "stt"
_USERDATA_LLM = "llm"
_USERDATA_TTS = "tts"


def _host_from_url(url: str) -> str | None:
    try:
        host = urlparse(url).hostname
    except Exception:
        return None
    return host or None


def _warm_dns(hosts: list[str]) -> None:
    seen: set[str] = set()
    for host in hosts:
        if not host or host in seen:
            continue
        seen.add(host)
        try:
            socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except OSError as exc:
            logger.debug("dns prewarm failed for %s: %s", host, exc)


def _build_stt() -> meta.STT:
    return meta.STT(model=META_STT_MODEL)


def _build_llm() -> Any:
    return build_inworld_llm()


def _build_tts() -> inworld.TTS:
    return inworld.TTS(
        model=INWORLD_TTS_MODEL,
        voice=INWORLD_TTS_VOICE,
        timestamp_type="WORD",
        timestamp_transport_strategy="SYNC",
        sample_rate=16000,
    )


def get_pipeline(proc: JobProcess) -> tuple[Any, Any, Any]:
    """Return ``(stt, llm, tts)``, rebuilding any piece missing from userdata."""
    ud = proc.userdata
    stt = ud.get(_USERDATA_STT)
    llm = ud.get(_USERDATA_LLM)
    tts = ud.get(_USERDATA_TTS)
    if stt is None:
        stt = _build_stt()
        ud[_USERDATA_STT] = stt
    if llm is None:
        llm = _build_llm()
        ud[_USERDATA_LLM] = llm
    if tts is None:
        tts = _build_tts()
        ud[_USERDATA_TTS] = tts
    return (
        stt,
        llm,
        tts,
    )


def warm_pipeline_connections(*, llm: Any, tts: Any, stt: Any | None = None) -> None:
    """Fire-and-forget provider connection warm (needs a running event loop)."""
    if llm is not None and hasattr(llm, "prewarm"):
        try:
            llm.prewarm()
        except Exception:
            logger.debug("llm connection prewarm failed", exc_info=True)
    if tts is not None and hasattr(tts, "prewarm"):
        try:
            tts.prewarm()
        except Exception:
            logger.debug("tts connection prewarm failed", exc_info=True)
    if stt is not None and hasattr(stt, "prewarm"):
        try:
            stt.prewarm()
        except Exception:
            logger.debug("stt connection prewarm failed", exc_info=True)


def prewarm(proc: JobProcess) -> None:
    """``AgentServer.setup_fnc`` — sync work only (no event loop yet)."""
    started = time.perf_counter()
    steps: list[str] = []

    def _mark(name: str) -> None:
        steps.append(f"{name}={time.perf_counter() - started:.3f}s")

    # Local FLAME / lipsync assets (``@cache`` + module-level mapping).
    from utils.flame.flame_model import load_filter, load_model
    from utils.flame.lipsync import LipsyncEvaluator  # noqa: F401 — loads mapping
    from utils.flame.stream import FlameStream  # noqa: F401
    from utils.lipsync_bridge import _ensure_patch

    load_model()
    load_filter()
    _ensure_patch()
    _mark("flame")

    # Shared aiohttp SSL context (parses CA bundle once).
    try:
        from livekit.agents.utils import http_context

        http_context._create_ssl_context()
        _mark("ssl")
    except Exception:
        logger.debug("ssl context prewarm failed", exc_info=True)

    # Construct pipeline plugins so job entrypoint skips init cost.
    try:
        proc.userdata[_USERDATA_STT] = _build_stt()
    except Exception:
        logger.exception("failed to construct Meta STT during prewarm")
    try:
        proc.userdata[_USERDATA_LLM] = _build_llm()
    except Exception:
        logger.exception("failed to construct Inworld LLM during prewarm")
    try:
        proc.userdata[_USERDATA_TTS] = _build_tts()
    except Exception:
        logger.exception("failed to construct Inworld TTS during prewarm")
    _mark("plugins")

    # DNS for providers touched on first turn / session end.
    meta_base = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
    _warm_dns(
        [
            _host_from_url(INWORLD_INFERENCE_BASE_URL),
            _host_from_url(INWORLD_LIST_MODELS_URL),
            _host_from_url(inworld.tts.DEFAULT_URL),
            _host_from_url(inworld.tts.DEFAULT_WS_URL),
            _host_from_url(meta.stt.DEFAULT_URL),
            _host_from_url(meta_base),
            _host_from_url(os.getenv("API_PUBLIC_BASE_URL") or ""),
            _host_from_url(os.getenv("BACKEND_BASE_URL") or ""),
        ]
    )
    _mark("dns")

    # Session-end path: import now so report / SAM / egress are not cold.
    try:
        import utils.egress_media  # noqa: F401
        import utils.muse_report  # noqa: F401
        import utils.sam_segment  # noqa: F401

        _mark("report_imports")
    except Exception:
        logger.debug("report import prewarm failed", exc_info=True)

    # Backend HTTP stack (httpx/httpcore) — already eager in backend_client.
    try:
        from utils.backend_client import backend_from_env

        backend_from_env()
        _mark("backend")
    except Exception:
        logger.debug("backend client prewarm failed", exc_info=True)

    logger.info(
        "job process prewarm complete elapsed=%.3fs %s",
        time.perf_counter() - started,
        " ".join(steps),
    )
