from __future__ import annotations

import logging
from typing import Any

from livekit.agents import Agent, AgentSession
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import silero

from .metadata import ProcessedDispatch
from .model_factory import build_llm, build_stt, build_tts

logger = logging.getLogger(__name__)


class InterviewAgent(Agent):
    def __init__(
        self,
        *,
        instructions: str,
        greeting: str,
        say: bool = True,
        defer_on_join_greeting: bool = False,
    ) -> None:
        super().__init__(instructions=instructions)
        self._greeting = greeting
        self._say = say
        self._defer_on_join_greeting = defer_on_join_greeting
        self._greeted = False
        self._greeted_on_speech = False

    async def on_enter(self) -> None:
        if self._defer_on_join_greeting:
            return
        await self._speak_greeting()

    def speak_on_join_greeting(self) -> None:
        if self._greeted:
            return
        try:
            self.session.say(self._greeting, allow_interruptions=True)
            self._greeted = True
        except Exception:
            logger.exception("failed deferred join greeting")

    def maybe_speak_greeting_on_first_speech(self) -> None:
        if self._greeted or self._greeted_on_speech:
            return
        if not self._defer_on_join_greeting:
            return
        # Avatar path already greeted via speak_on_join_greeting.
        self._greeted_on_speech = True

    async def _speak_greeting(self) -> None:
        if self._greeted:
            return
        if self._say:
            await self.session.say(self._greeting, allow_interruptions=True)
        else:
            self.session.generate_reply(instructions="Greet the candidate briefly.")
        self._greeted = True


def build_agent_session(
    processed: ProcessedDispatch,
    *,
    aec_warmup_duration: float = 2.0,
) -> AgentSession:
    config = processed.metadata.config
    return AgentSession(
        stt=build_stt(config),
        llm=build_llm(config),
        tts=build_tts(config),
        vad=silero.VAD.load(),
        aec_warmup_duration=aec_warmup_duration,
    )


def build_agent(
    processed: ProcessedDispatch,
    *,
    say: bool = True,
    defer_on_join_greeting: bool = False,
) -> InterviewAgent:
    cfg = processed.metadata.config
    return InterviewAgent(
        instructions=cfg.instructions,
        greeting=cfg.greeting,
        say=say,
        defer_on_join_greeting=defer_on_join_greeting,
    )


# Re-export for type checkers / callers that import RoomOptions indirectly.
__all__ = ["InterviewAgent", "build_agent", "build_agent_session", "RoomOptions"]
