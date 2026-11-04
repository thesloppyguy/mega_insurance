import asyncio
import json
import logging
import math
import time
from typing import Any

from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import (
    AgentServer,
    AgentSession,
    room_io,
    TurnHandlingOptions,
)
from livekit.agents.utils.hw import get_cpu_monitor
from livekit.agents.worker import ServerEnvOption

from agents.assistant import Assistant
from utils.backend_client import backend_from_env
from utils.helper import (
    SESSION_END_STATE,
    normalize_usage_payload,
    on_session_end,
    serialize_history,
)
from utils.lipsync_bridge import LipsyncBridge
from utils.metadata import parse_job_metadata, resolve_caller_name, resolve_session_id
from utils.prewarm import get_pipeline, prewarm, warm_pipeline_connections

load_dotenv(".env")

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

MAX_DURATION_SECONDS = 600
INACTIVITY_END_STRIKES = 3

server = AgentServer(
    # Keep at least one warm process in dev so local sessions skip cold spawn.
    num_idle_processes=ServerEnvOption(
        dev_default=1,
        prod_default=max(1, math.ceil(get_cpu_monitor().cpu_count())),
    ),
    # Import into the forkserver image (Linux) so child processes inherit warm state.
    preload_modules=[
        "utils.backend_client",
        "utils.flame.flame_model",
        "utils.flame.lipsync",
        "utils.flame.stream",
        "utils.inworld_llm",
        "utils.lipsync_bridge",
        "utils.prewarm",
    ],
)
server.setup_fnc = prewarm


@server.rtc_session(agent_name="mavrik", on_session_end=on_session_end)
async def my_agent(ctx: agents.JobContext):
    metadata = parse_job_metadata(ctx.job.metadata)
    session_id = resolve_session_id(metadata, fallback=ctx.room.name)
    caller_name = resolve_caller_name(metadata)
    recording_enabled = metadata.get("recording_enabled", True) is not False

    ctx.log_context_fields = {
        "room": ctx.room.name,
        "session_id": session_id,
    }

    # Reuse process-prewarmed plugins; open LLM/TTS connections while we join the room.
    stt, llm, tts = get_pipeline(ctx.proc)
    warm_pipeline_connections(stt=stt, llm=llm, tts=tts)

    await ctx.connect()

    backend = backend_from_env()
    if session_id:
        await backend.patch_session_lifecycle(
            session_id,
            status="active",
            livekit_job_id=ctx.job.id,
        )

    room_options = room_io.RoomOptions(
        text_input=True,
        close_on_disconnect=True,
        delete_room_on_close=True,
    )

    agent = Assistant(caller_name=caller_name)

    session = AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        expressive=True,
        use_tts_aligned_transcript=True,
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

    lipsync_bridge = LipsyncBridge(ctx.room, send_phonemes=False)
    lipsync_bridge.attach(session)

    metrics_buffer: list[dict[str, Any]] = []
    _ONESHOT_CONTEXT_TYPES = frozenset(
        {
            "id_captured",
            "face_captured",
            "body_captured",
            "aadhaar_otp_verified",
            "aadhaar_otp_failed",
            # Legacy event names (pre-Deepvue); keep for in-flight sessions.
            "otp_submitted",
            "otp_resend_requested",
        }
    )
    _recent_context_events: dict[str, float] = {}
    _CONTEXT_DEDUPE_WINDOW_S = 5.0
    _context_apply_lock = asyncio.Lock()

    async def _wait_for_agent_speech_idle() -> None:
        while True:
            handle = session.current_speech
            if handle is not None and not handle.done():
                logger.info("add_context waiting for current speech to finish")
                await handle.wait_for_playout()
                continue
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
            if event_type == "id_captured" and isinstance(detail.get("ocr"), dict):
                ocr = detail["ocr"]
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
                            f"{event} Briefly acknowledge that identity capture completed in the user's language if known. "
                            "Use the OCR result in the system message to check whether the "
                            "scanned ID type matches what you requested. If it does not match, "
                            "politely ask the candidate to present the correct document. "
                            "Otherwise continue with the next step of the conversation."
                        )
                    else:
                        instructions = (
                            f"{event} Briefly acknowledge that identity capture completed in the user's language if known."
                            "and continue with the next step of the conversation."
                        )
                elif event_type == "face_captured":
                    instructions = (
                        f"{event} Briefly acknowledge that face capture completed in the user's language if known."
                        "and continue with the next step of the conversation."
                    )
                elif event_type == "body_captured":
                    instructions = (
                        f"{event} Briefly acknowledge that full body capture completed in the user's language if known."
                        "and continue with the next step of the conversation."
                    )
                elif event_type == "aadhaar_otp_verified":
                    instructions = (
                        f"{event} Confirm that Aadhaar verification succeeded in the user's language if known, "
                        "then continue with the next script step."
                    )
                elif event_type == "aadhaar_otp_failed":
                    instructions = (
                        f"{event} Tell the candidate the one-time password was not accepted in the user's language if known. "
                        "Offer one resend or retry. Do not proceed to QnA until verification succeeds, "
                        "unless they explicitly decline."
                    )
                elif event_type == "otp_submitted":
                    instructions = (
                        f"{event} Acknowledge the submission in the user's language if known "
                        "and wait for the verified or failed result from the frontend."
                    )
                elif event_type == "otp_resend_requested":
                    instructions = f"{event} Tell the candidate to check for a new code in the user's language if known."
                else:
                    instructions = (
                        f"The frontend reported: {event}. "
                        "Briefly tell the candidate what to do in the user's language if known."
                    )
                session.generate_reply(
                    instructions=instructions,
                    allow_interruptions=True,
                    chat_ctx=chat_ctx,
                )
            elif action == "say":
                session.say(event, allow_interruptions=False)

    async def add_context(rpc_data: rtc.RpcInvocationData) -> str:
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
        if ev.new_state == "away":
            away_strikes += 1
            logger.info(
                "user marked away (strike %s/%s)", away_strikes, INACTIVITY_END_STRIKES
            )
            if away_strikes >= INACTIVITY_END_STRIKES:
                logger.info("user away too long; ending session")
                session.shutdown()
                return
            try:
                session.generate_reply(
                    instructions=(
                        "Ask the user if they are still there, "
                        "in the user's language if known."
                    ),
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

    async def _start_composite_egress() -> None:
        if not recording_enabled or not session_id:
            return
        # Wait briefly so participant tracks are published.
        await asyncio.sleep(2.0)
        result = await backend.start_session_egress(
            session_id,
            composite=True,
            audio_only=False,
        )
        if result:
            logger.info(
                "composite egress started session_id=%s result=%s", session_id, result
            )
        else:
            logger.warning("composite egress failed to start session_id=%s", session_id)

    egress_task = asyncio.create_task(_start_composite_egress())

    @session.on("close")
    def _on_session_close(_ev):
        if max_duration_task is not None and not max_duration_task.done():
            max_duration_task.cancel()
        if egress_task is not None and not egress_task.done():
            egress_task.cancel()
        history_payload = serialize_history(getattr(session, "history", None))
        usage_payload = normalize_usage_payload(getattr(session, "usage", None))
        SESSION_END_STATE[ctx.job.id] = {
            "session_id": session_id,
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
