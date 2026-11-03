import asyncio
import json
import logging
import time
from typing import Any

from livekit import rtc
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    AgentServer,
    AgentSession,
    Agent,
    room_io,
    TurnHandlingOptions,
)
from livekit.plugins import google, meta, inworld
from utils.helper import (
    on_session_end,
    SESSION_END_STATE,
    serialize_history,
    normalize_usage_payload,
)
from utils.lipsync_bridge import LipsyncBridge
from agents.assistant import Assistant

load_dotenv(".env")

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


## CONSTANTS ##
MAX_DURATION_SECONDS = 600
INACTIVITY_END_STRIKES = 3


server = AgentServer()


@server.rtc_session(agent_name="agent-test", on_session_end=on_session_end)
async def my_agent(ctx: agents.JobContext):
    ctx.log_context_fields = {"room": ctx.room.name}
    metadata = ctx.job.metadata

    ctx.log_context_fields |= {
        "session_id": str(metadata.session_id),
    }

    await ctx.connect()

    room_options = room_io.RoomOptions(
        text_input=True,
        close_on_disconnect=True,
        delete_room_on_close=True,
    )

    agent = Assistant()

    session = AgentSession(
        stt=meta.STT(model="muse-voice-transcribe-1.0"),
        llm=google.LLM(model="gemini-3.5-flash-lite"),
        tts=inworld.TTS(model="inworld-tts-2-flash", voice_id="Aarav"),
        user_away_timeout=20,
        aec_warmup_duration=2.0,
        turn_handling=TurnHandlingOptions(
            turn_detection="stt",
            endpointing={"min_delay": 0.1, "max_delay": 2.0},
            interruption={
                "min_duration": 0.5,
                "false_interruption_timeout": None,
                "resume_false_interruption": False,
            },
        ),
    )

    lipsync_bridge = LipsyncBridge(ctx.room, send_phonemes=True)
    lipsync_bridge.attach(session)

    metrics_buffer: list[dict[str, Any]] = []
    # One-shot frontend events should not drive multiple generate_reply turns.
    _ONESHOT_CONTEXT_TYPES = frozenset(
        {
            "id_captured",
            "face_captured",
            "body_captured",
            "otp_submitted",
            "otp_resend_requested",
        }
    )
    _recent_context_events: dict[str, float] = {}
    _CONTEXT_DEDUPE_WINDOW_S = 5.0
    # Serialize deferred context applies so replies don't race mid-speech.
    _context_apply_lock = asyncio.Lock()

    async def _wait_for_agent_speech_idle() -> None:
        """Wait until in-flight speech is fully generated/flushed/played out."""
        while True:
            handle = session.current_speech
            if handle is not None and not handle.done():
                logger.info("add_context waiting for current speech to finish")
                await handle.wait_for_playout()
                continue
            # Thinking/speaking without a handle yet: generation not flushed.
            if session.agent_state in ("thinking", "speaking"):
                await asyncio.sleep(0.05)
                continue
            break

    async def _apply_add_context(
        *,
        event: str,
        action: str,
        event_type: str,
        detail: dict[str, Any],
    ) -> None:
        async with _context_apply_lock:
            await _wait_for_agent_speech_idle()

            chat_ctx = agent.chat_ctx.copy()
            if event_type == "otp_submitted" and detail.get("code") is not None:
                system_content = (
                    f"Frontend event ({event_type}): {event} "
                    f"Submitted code: {detail.get('code')!r}."
                )
            elif event_type == "id_captured" and isinstance(detail.get("ocr"), dict):
                ocr = detail["ocr"]
                print("ocr", ocr)
                system_content = (
                    f"Frontend event ({event_type}): {event} "
                    "ID card Details for further verification: "
                    f"{json.dumps(ocr, ensure_ascii=False)}"
                )
            else:
                system_content = f"Frontend event ({event_type}): {event}"
            chat_ctx.add_message(role="system", content=system_content)
            await agent.update_chat_ctx(chat_ctx)

            if action == "generate_reply":
                if event_type == "id_captured":
                    if isinstance(detail.get("ocr"), dict):
                        instructions = (
                            f"{event} Briefly acknowledge that identity capture completed. "
                            "Use the OCR result in the system message to check whether the "
                            "scanned ID type matches what you requested. If it does not match, "
                            "politely ask the candidate to present the correct document. "
                            "Otherwise continue with the next step of the conversation."
                        )
                    else:
                        instructions = (
                            f"{event} Briefly acknowledge that identity capture completed "
                            "and continue with the next step of the conversation."
                        )
                elif event_type == "face_captured":
                    instructions = (
                        f"{event} Briefly acknowledge that face capture completed "
                        "and continue with the next step of the conversation."
                    )
                elif event_type == "body_captured":
                    instructions = (
                        f"{event} Briefly acknowledge that full body capture completed "
                        "and continue with the next step of the conversation."
                    )
                elif event_type == "otp_submitted":
                    instructions = (
                        f"{event} The submitted code is in the system message above. "
                        "Validate it if you can, then tell the candidate the result "
                        "and continue."
                    )
                elif event_type == "otp_resend_requested":
                    instructions = (
                        f"{event} Resend the one-time password if possible, then "
                        "tell the candidate to check for a new code."
                    )
                else:
                    instructions = (
                        f"The frontend reported: {event}. "
                        "Briefly tell the candidate what to do."
                    )
                # Gemini Live / audio realtime cannot honor allow_interruptions=False.
                allow_interruptions = True
                session.generate_reply(
                    instructions=instructions,
                    allow_interruptions=allow_interruptions,
                    chat_ctx=chat_ctx,
                )
            elif action == "say":
                session.say(
                    event,
                    allow_interruptions=False,
                )

    async def add_context(rpc_data: rtc.RpcInvocationData) -> str:
        # LiveKit RPC handlers MUST return a str. Returning SpeechHandle from
        # generate_reply()/say() surfaces as Application Error on the client
        # (OTP submit / face capture / proctoring all break).
        # Also return immediately: waiting for playout here can exceed RPC timeout.
        payload = json.loads(rpc_data.payload)
        event = payload["state"]
        action = payload["action"]
        event_type = payload.get("type", "unknown")
        logger.info(
            "add_context event_type=%s event=%s action=%s", event_type, event, action
        )
        now = time.monotonic()
        if event_type in _ONESHOT_CONTEXT_TYPES:
            last_at = _recent_context_events.get(event_type)
            if last_at is not None and now - last_at < _CONTEXT_DEDUPE_WINDOW_S:
                return "ok_duplicate"
            _recent_context_events[event_type] = now

        detail = (
            payload.get("details") if isinstance(payload.get("details"), dict) else {}
        )

        async def _run() -> None:
            try:
                await _apply_add_context(
                    event=event,
                    action=action,
                    event_type=event_type,
                    detail=detail,
                )
            except Exception:
                logger.exception(
                    "add_context deferred apply failed event_type=%s", event_type
                )

        asyncio.create_task(_run())
        return "ok"

    ctx.room.local_participant.register_rpc_method("add_context", add_context)

    @session.on("conversation_item_added")
    def _on_conversation_item(ev: Any) -> None:
        try:
            item = getattr(ev, "item", None)
            metrics = getattr(item, "metrics", None) if item is not None else None
            if metrics is None:
                return
            if hasattr(metrics, "model_dump"):
                metrics_buffer.append(metrics.model_dump())
            elif isinstance(metrics, dict):
                metrics_buffer.append(metrics)
            else:
                metrics_buffer.append({"raw": repr(metrics)})
        except Exception:
            logger.exception("failed to buffer conversation item metrics")

    away_strikes = 0

    @session.on("user_state_changed")
    def _on_user_state_changed(ev):
        nonlocal away_strikes
        if ev.new_state == "speaking":
            agent.maybe_speak_greeting_on_first_speech()
        if ev.new_state == "away":
            away_strikes += 1
            logger.info(
                "user marked away (strike %s/%s)", away_strikes, INACTIVITY_END_STRIKES
            )
            if away_strikes >= INACTIVITY_END_STRIKES:
                logger.info("user away too long; ending session")
                session.shutdown()
                return
            # First two (or all but last) away events: speak the warning.
            try:
                return session.generate_reply(
                    "Ask the user if they are still there and if not in users language.",
                    allow_interruptions=True,
                )
            except Exception:
                logger.exception("failed to speak inactivity warning")
            return
        away_strikes = 0

    room_options.audio_output = room_io.AudioOutputOptions()

    async def _end_on_max_duration() -> None:
        await asyncio.sleep(MAX_DURATION_SECONDS)
        logger.info(
            "max call duration reached (%ss); ending session", MAX_DURATION_SECONDS
        )
        session.shutdown()

    max_duration_task = asyncio.create_task(_end_on_max_duration())

    @session.on("close")
    def _on_session_close(_ev):
        if max_duration_task is not None and not max_duration_task.done():
            max_duration_task.cancel()
        # Snapshot conversation + usage + metrics for on_session_end.
        # Do NOT post a metrics_flush report here — that can overwrite transcripts.
        history_payload = serialize_history(getattr(session, "history", None))
        usage_payload = normalize_usage_payload(getattr(session, "usage", None))
        SESSION_END_STATE[ctx.job.id] = {
            "history": history_payload,
            "usage": usage_payload,
            "metrics": list(metrics_buffer),
        }

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_options,
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
