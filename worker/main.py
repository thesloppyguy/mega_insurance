import asyncio
import json
import logging
import os
import time
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    AgentServer,
    BackgroundAudioPlayer,
    JobContext,
    JobProcess,
    cli,
    room_io,
)
from livekit.agents import utils as lk_utils
from livekit.agents.voice import UserStateChangedEvent

import utils.patch as patch  # noqa: F401
from utils.analyzers import MuseAnalyzers
from utils.audio_clips import build_background_player_kwargs
from utils.backend_client import BackendClient
from utils.capture_pipeline import CapturePipeline
from utils.helper import (
    collect_recording_egresses,
    dial_outbound_sip,
    recording_egresses_payload,
    resolve_user_participant,
    start_recording_egresses,
)
from utils.lipsync_bridge import LipsyncBridge
from utils.metadata import process_dispatch_metadata
from utils.model_factory import is_inworld_tts
from utils.post_process import build_underwriting_report
from utils.proctor import LiveProctor
from utils.session_factory import build_agent, build_agent_session
from utils.voicemail import (
    resolve_voicemail_action,
    retry_scheduled_at_iso,
    voicemail_leave_text,
)

load_dotenv()

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Optional plugins — keep worker bootable without every avatar/noise package.
try:
    from livekit.plugins import anam as anam_plugin
except Exception:  # pragma: no cover
    anam_plugin = None  # type: ignore

try:
    from livekit.plugins import ai_coustics
except Exception:  # pragma: no cover
    ai_coustics = None  # type: ignore


def prewarm(proc: JobProcess) -> None:
    """Warm process-level assets before a job binds the agent event loop."""
    for mod in (
        "livekit.plugins.google",
        "livekit.plugins.meta",
        "livekit.plugins.inworld",
        "livekit.plugins.anam",
        "livekit.plugins.silero",
    ):
        try:
            __import__(mod)
        except Exception:
            pass


server = AgentServer(setup_fnc=prewarm, num_idle_processes=1)

_INACTIVITY_PROMPT = "Are you still there?"
_SESSION_END_STATE: dict[str, dict[str, Any]] = {}
_SESSION_CLOSE_EVENTS: dict[str, asyncio.Event] = {}


def _session_supports_say(processed: Any) -> bool:
    if processed.use_live_pipeline:
        return False
    if processed.use_realtime_pipeline:
        realtime = processed.metadata.config.realtime
        return (
            realtime is not None
            and realtime.output_modality == "text"
            and processed.metadata.config.tts is not None
        )
    return True


async def _ensure_avatar_joined(
    avatar: Any, *, room: rtc.Room, timeout: float = 30.0
) -> None:
    await avatar.wait_for_join(timeout=timeout)

    identity = getattr(avatar, "avatar_identity", None)
    if not identity:
        return

    participant = room.remote_participants.get(identity)
    if participant is None and room.local_participant.identity != identity:
        logger.info(
            "wait_for_join returned early; waiting for avatar participant=%s", identity
        )
        await asyncio.wait_for(
            lk_utils.wait_for_participant(
                room=room, identity=identity, include_local=True
            ),
            timeout=timeout,
        )

    has_video = False
    participant = room.remote_participants.get(identity)
    if participant is None and room.local_participant.identity == identity:
        participant = room.local_participant
    if participant is not None:
        has_video = any(
            pub.kind == rtc.TrackKind.KIND_VIDEO
            for pub in participant.track_publications.values()
        )

    if not has_video:
        logger.info("waiting for avatar video track identity=%s", identity)
        await asyncio.wait_for(
            lk_utils.wait_for_track_publication(
                room=room,
                identity=identity,
                kind=rtc.TrackKind.KIND_VIDEO,
                include_local=True,
            ),
            timeout=timeout,
        )


def _speak_scripted(
    session: Any,
    text: str,
    *,
    processed: Any,
    allow_interruptions: bool = True,
) -> Any:
    return session.say(text, allow_interruptions=allow_interruptions)


def _serialize_report(report: Any) -> dict[str, Any]:
    if report is None:
        return {}
    if hasattr(report, "to_dict"):
        try:
            return dict(report.to_dict())
        except Exception:
            pass
    if hasattr(report, "model_dump"):
        try:
            return report.model_dump()
        except Exception:
            pass
    if isinstance(report, dict):
        return report
    return {"repr": repr(report)}


def _serialize_history(history: Any) -> dict[str, Any] | None:
    if history is None:
        return None
    if hasattr(history, "to_dict"):
        try:
            payload = history.to_dict(exclude_timestamp=False)
            return dict(payload) if isinstance(payload, dict) else {"items": payload}
        except Exception:
            logger.exception("failed to serialize session.history")
    if isinstance(history, dict):
        return history
    return None


def _normalize_usage_payload(usage: Any) -> dict[str, Any] | list[Any] | None:
    if usage is None:
        return None
    if isinstance(usage, list):
        return usage
    if isinstance(usage, dict):
        return usage
    if hasattr(usage, "model_usage"):
        model_usage = getattr(usage, "model_usage", None)
        if isinstance(model_usage, list):
            rows: list[Any] = []
            for item in model_usage:
                if hasattr(item, "model_dump"):
                    rows.append(item.model_dump(exclude_defaults=True))
                elif isinstance(item, dict):
                    rows.append(item)
                else:
                    rows.append({"raw": repr(item)})
            return {"model_usage": rows}
    if hasattr(usage, "model_dump"):
        try:
            dumped = usage.model_dump()
            return dumped if isinstance(dumped, (dict, list)) else {"raw": dumped}
        except Exception:
            pass
    return {"raw": repr(usage)}


def _chat_history_has_items(report: dict[str, Any]) -> bool:
    chat_history = report.get("chat_history")
    if isinstance(chat_history, list):
        return len(chat_history) > 0
    if isinstance(chat_history, dict):
        items = chat_history.get("items")
        return isinstance(items, list) and len(items) > 0
    return False


async def _on_session_end(ctx: JobContext) -> None:
    """Persist LiveKit session report + Muse underwriting enrichment."""
    try:
        processed = process_dispatch_metadata(ctx.job.metadata)
    except ValueError:
        logger.exception("invalid dispatch metadata on session end")
        return

    backend = BackendClient(
        processed.tools_context.backend_base_url,
        processed.tools_context.worker_api_key,
    )
    close_event = _SESSION_CLOSE_EVENTS.get(ctx.job.id)
    if close_event is not None:
        try:
            await asyncio.wait_for(close_event.wait(), timeout=45.0)
        except TimeoutError:
            logger.warning("timed out waiting for session close snapshot")
    snapshot = _SESSION_END_STATE.pop(ctx.job.id, {})
    _SESSION_CLOSE_EVENTS.pop(ctx.job.id, None)
    report_payload: dict[str, Any] = {}
    usage_payload: dict[str, Any] | list[Any] | None = None
    metrics_payload: list[dict[str, Any]] = list(snapshot.get("metrics") or [])

    try:
        report = ctx.make_session_report()
        report_payload = _serialize_report(report)
    except Exception:
        logger.exception("make_session_report failed")

    if not _chat_history_has_items(report_payload):
        history_snapshot = snapshot.get("history")
        if isinstance(history_snapshot, dict):
            report_payload = {**report_payload, "chat_history": history_snapshot}

    try:
        usage_payload = _normalize_usage_payload(
            report_payload.get("usage") if isinstance(report_payload, dict) else None
        )
        if usage_payload is None:
            usage_payload = _normalize_usage_payload(snapshot.get("usage"))
    except Exception:
        usage_payload = _normalize_usage_payload(snapshot.get("usage"))

    underwriting: dict[str, Any] | None = None
    try:
        built = await build_underwriting_report(
            backend=backend,
            session_id=processed.tools_context.session_id,
            capture_results=snapshot.get("capture_results") or {},
            proctor_summary=snapshot.get("proctor_summary"),
            chat_history=report_payload.get("chat_history") or snapshot.get("history"),
            analyzers=MuseAnalyzers(),
        )
        underwriting = built.model_dump()
    except Exception:
        logger.exception("underwriting post-process failed")

    posted = await backend.post_session_report(
        processed.tools_context.session_id,
        report=report_payload,
        usage=usage_payload,
        metrics=metrics_payload,
        is_final=True,
        underwriting_report=underwriting,
    )
    if posted:
        logger.info(
            "posted final session report session_id=%s underwriting=%s",
            processed.tools_context.session_id,
            bool(underwriting),
        )
    else:
        logger.error(
            "failed to post final session report session_id=%s",
            processed.tools_context.session_id,
        )

    patched = await backend.patch_session_lifecycle(
        processed.tools_context.session_id,
        status="completed",
        end_reason="completed",
    )
    if not patched:
        logger.warning(
            "failed to patch session lifecycle to completed session_id=%s",
            processed.tools_context.session_id,
        )


@server.rtc_session(agent_name="mavrik", on_session_end=_on_session_end)
async def entrypoint(ctx: JobContext):
    ctx.log_context_fields = {"room": ctx.room.name}
    try:
        processed = process_dispatch_metadata(ctx.job.metadata)
    except ValueError:
        logger.exception("invalid dispatch metadata")
        ctx.shutdown()
        return

    ctx.log_context_fields |= {
        "session_id": str(processed.metadata.session_id),
        "organization_id": str(processed.metadata.organization_id),
        "campaign_id": str(processed.metadata.campaign_id or ""),
    }

    backend = BackendClient(
        processed.tools_context.backend_base_url,
        processed.tools_context.worker_api_key,
    )
    analyzers = MuseAnalyzers()
    capture = CapturePipeline(
        backend=backend,
        session_id=processed.tools_context.session_id,
        analyzers=analyzers,
    )
    proctor: LiveProctor | None = None

    await ctx.connect()

    await backend.patch_session_lifecycle(
        processed.tools_context.session_id,
        status="active",
        livekit_job_id=ctx.job.id,
    )

    is_phone_call = processed.dial_phone_number is not None
    use_avatar = processed.use_avatar and not is_phone_call
    avatar_started = False
    avatar_identity: str | None = None
    avatar_provider_id = (
        processed.metadata.config.avatar.provider_id
        if processed.metadata.config.avatar
        else None
    )
    use_arkit_lipsync = False
    if use_avatar and avatar_provider_id == "arkit":
        if not is_inworld_tts(processed.metadata.config):
            logger.warning(
                "arkit avatar requires Inworld TTS; falling back to voice-only"
            )
            use_avatar = False
        else:
            use_arkit_lipsync = True
    defer_on_join_greeting = use_avatar

    noise_cfg = processed.metadata.config.noise_filtering
    audio_input_kwargs: dict[str, Any] = {}
    if noise_cfg.enabled and ai_coustics is not None:
        level = max(0.0, min(1.0, float(noise_cfg.suppression_level) / 100.0))
        audio_input_kwargs["noise_cancellation"] = ai_coustics.audio_enhancement(
            model=ai_coustics.EnhancerModel.QUAIL_VF_S,
            model_parameters=ai_coustics.ModelParameters(enhancement_level=level),
        )
    elif noise_cfg.enabled:
        logger.warning("noise filtering requested but ai_coustics plugin unavailable")

    room_options = room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(**audio_input_kwargs),
        text_input=True,
        close_on_disconnect=True,
        delete_room_on_close=True,
    )

    session = build_agent_session(processed, aec_warmup_duration=2.0)
    lipsync_bridge: LipsyncBridge | None = None
    if use_arkit_lipsync:
        lipsync_bridge = LipsyncBridge(
            ctx.room,
            send_phonemes=os.getenv("ARKIT_SEND_PHONEMES", "0").lower()
            in ("1", "true", "yes"),
        )
        lipsync_bridge.attach(session)
        logger.info("arkit lipsync bridge attached")

    agent = build_agent(
        processed,
        say=not processed.use_realtime_pipeline,
        defer_on_join_greeting=defer_on_join_greeting,
    )
    session.userdata = processed.tools_context

    metrics_buffer: list[dict[str, Any]] = []
    _ONESHOT_CONTEXT_TYPES = frozenset(
        {
            "id_captured",
            "face_captured",
            "body_captured",
            "liveness_captured",
            "precheck",
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
            # Muse analysis for capture / proctor client events
            analysis: dict[str, Any] | None = None
            if event_type in {
                "precheck",
                "face_captured",
                "liveness_captured",
                "id_captured",
                "body_captured",
            }:
                analysis = await capture.handle(event_type, detail)
            elif event_type == "proctor_signal" and proctor is not None:
                pe = proctor.ingest_client_signal(detail)
                analysis = pe.model_dump()

            await _wait_for_agent_speech_idle()

            chat_ctx = agent.chat_ctx.copy()
            if event_type == "otp_submitted" and detail.get("code") is not None:
                system_content = (
                    f"Frontend event ({event_type}): {event} "
                    f"Submitted code: {detail.get('code')!r}."
                )
            elif analysis:
                system_content = (
                    f"Frontend event ({event_type}): {event} "
                    f"Analysis: {json.dumps(analysis)[:2000]}"
                )
            else:
                system_content = f"Frontend event ({event_type}): {event}"
            chat_ctx.add_message(role="system", content=system_content)
            await agent.update_chat_ctx(chat_ctx)

            if action == "generate_reply":
                if event_type == "precheck":
                    guidance = (analysis or {}).get("guidance") or event
                    instructions = (
                        f"{guidance} Tell the candidate what to adjust if needed, "
                        "otherwise continue to face capture."
                    )
                elif event_type == "id_captured":
                    instructions = (
                        f"{event} Briefly acknowledge KYC capture, mention any clear "
                        "issues without inventing ID numbers, then continue."
                    )
                elif event_type == "face_captured":
                    instructions = (
                        f"{event} Briefly acknowledge face capture and continue to "
                        "liveness instructions."
                    )
                elif event_type == "liveness_captured":
                    instructions = (
                        f"{event} Tell the candidate whether liveness looked good and "
                        "continue to the ID document step."
                    )
                elif event_type == "body_captured":
                    view = detail.get("view") or "front"
                    instructions = (
                        f"{event} Acknowledge the {view} body capture. "
                        "If estimates are mentioned, disclose they are AI estimates only, "
                        "not clinical measurements. Continue to the next step."
                    )
                elif event_type == "proctor_signal":
                    instructions = (
                        f"{event} Softly warn the candidate about the proctoring issue "
                        "if severity is medium or high, otherwise continue normally."
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
                session.generate_reply(
                    instructions=instructions,
                    allow_interruptions=False,
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
                # body front/back are distinct — allow if view differs
                if event_type != "body_captured":
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

    # Silence unused telephony/voicemail imports for lint while keeping API surface.
    _ = (dial_outbound_sip, resolve_voicemail_action, retry_scheduled_at_iso, voicemail_leave_text)

    away_strikes = 0
    inactivity_end_strikes = 3
    inactivity_enabled = bool(
        processed.inactivity_warning_seconds or processed.inactivity_end_seconds
    )
    if processed.inactivity_end_seconds and processed.inactivity_warning_seconds:
        inactivity_end_strikes = max(
            3,
            processed.inactivity_end_seconds
            // max(processed.inactivity_warning_seconds, 1),
        )

    @session.on("user_state_changed")
    def _on_user_state_changed(ev: UserStateChangedEvent):
        nonlocal away_strikes
        if ev.new_state == "speaking":
            agent.maybe_speak_greeting_on_first_speech()
        if not inactivity_enabled:
            return
        if ev.new_state == "away":
            away_strikes += 1
            logger.info(
                "user marked away (strike %s/%s)", away_strikes, inactivity_end_strikes
            )
            if away_strikes >= inactivity_end_strikes:
                logger.info("user away too long; ending session")
                session.shutdown()
                return
            try:
                _speak_scripted(session, _INACTIVITY_PROMPT, processed=processed)
            except Exception:
                logger.exception("failed to speak inactivity warning")
            return
        away_strikes = 0

    linked_user_identity: str | None = None
    avatar_id: str | None = None
    pending_avatar = False
    if use_avatar:
        if processed.metadata.config.avatar:
            avatar_id = processed.avatar.external_avatar_id

        if not avatar_id:
            logger.warning(
                "avatar enabled but external_avatar_id is missing; using voice-only"
            )
            use_avatar = False
        else:
            participant = resolve_user_participant(ctx.room)
            if participant is None:
                try:
                    await asyncio.wait_for(ctx.wait_for_participant(), timeout=10)
                    participant = resolve_user_participant(ctx.room)
                except TimeoutError:
                    logger.warning("avatar requested but no participant joined in time")

            if participant is None:
                logger.warning(
                    "avatar requested but no participant is available; using voice-only"
                )
                use_avatar = False
            else:
                linked_user_identity = participant.identity
                pending_avatar = True

    room_options.audio_output = room_io.AudioOutputOptions()

    if linked_user_identity is None:
        user = resolve_user_participant(ctx.room)
        if user is not None:
            linked_user_identity = user.identity
    if linked_user_identity is not None:
        room_options.participant_identity = linked_user_identity
        logger.info("RoomIO linked participant_identity=%s", linked_user_identity)

    max_duration_task: asyncio.Task[None] | None = None
    if processed.max_duration_seconds:
        max_duration = processed.max_duration_seconds

        async def _end_on_max_duration() -> None:
            await asyncio.sleep(max_duration)
            logger.info("max call duration reached (%ss); ending session", max_duration)
            session.shutdown()

        max_duration_task = asyncio.create_task(_end_on_max_duration())

    close_event = asyncio.Event()
    _SESSION_CLOSE_EVENTS[ctx.job.id] = close_event

    @session.on("close")
    def _on_session_close(_ev):
        if max_duration_task is not None and not max_duration_task.done():
            max_duration_task.cancel()

        async def _finalize_proctor() -> None:
            proctor_summary = None
            try:
                active = proctor
                if active is not None:
                    try:
                        summary = await active.stop()
                        proctor_summary = summary.model_dump()
                    except Exception:
                        logger.exception("proctor stop failed")
                history_payload = _serialize_history(getattr(session, "history", None))
                usage_payload = _normalize_usage_payload(getattr(session, "usage", None))
                _SESSION_END_STATE[ctx.job.id] = {
                    "history": history_payload,
                    "usage": usage_payload,
                    "metrics": list(metrics_buffer),
                    "capture_results": dict(capture.results),
                    "proctor_summary": proctor_summary,
                }
            finally:
                close_event.set()

        asyncio.create_task(_finalize_proctor())

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_options,
    )

    if pending_avatar and avatar_id:
        try:
            if avatar_provider_id == "anam" and anam_plugin is not None:
                avatar = anam_plugin.AvatarSession(
                    persona_config=anam_plugin.PersonaConfig(
                        name=processed.avatar.name or "Mavrik",
                        avatarId=avatar_id,
                    ),
                )
                await avatar.start(session, room=ctx.room)
                await _ensure_avatar_joined(avatar, room=ctx.room)
                avatar_identity = getattr(avatar, "avatar_identity", None)
                avatar_started = True
                logger.info(
                    "anam avatar ready avatar_id=%s identity=%s",
                    avatar_id,
                    avatar_identity,
                )
            elif avatar_provider_id == "arkit":
                avatar_started = True
                logger.info("arkit avatar ready (client-rendered) avatar_id=%s", avatar_id)
            else:
                logger.warning(
                    "unsupported avatar provider_id=%s; voice-only", avatar_provider_id
                )
                use_avatar = False
        except Exception:
            logger.exception("avatar startup failed; falling back to voice-only")
            use_avatar = False
            if lipsync_bridge is not None:
                lipsync_bridge.detach(session)
                lipsync_bridge = None

    if defer_on_join_greeting and use_avatar:
        agent.speak_on_join_greeting()

    # Live proctoring after user is linked
    async def _on_proctor_alert(event: Any) -> None:
        if event.severity not in ("high", "medium"):
            return
        try:
            session.generate_reply(
                instructions=(
                    f"Proctoring alert: {event.message}. Softly ask the candidate to "
                    "look at the camera and keep only themselves in frame."
                ),
                allow_interruptions=True,
            )
        except Exception:
            logger.exception("proctor alert reply failed")

    proctor = LiveProctor(
        room=ctx.room,
        backend=backend,
        session_id=processed.tools_context.session_id,
        analyzers=analyzers,
        on_high_severity=_on_proctor_alert,
    )
    proctor.start(linked_user_identity)

    if processed.metadata.recording_enabled:
        recording_targets = collect_recording_egresses(
            ctx.room,
            organization_id=str(processed.metadata.organization_id),
            session_id=str(processed.metadata.session_id),
            room_name=ctx.room.name,
            user_identity=linked_user_identity,
            avatar_identity=avatar_identity if avatar_started else None,
        )
        if not recording_targets:
            logger.warning("recording enabled but no egress targets available")
        else:
            started = await backend.start_session_egress(
                processed.tools_context.session_id,
                tracks=recording_egresses_payload(recording_targets),
                audio_only=is_phone_call,
            )
            if started is not None:
                logger.info(
                    "started session egress via backend session_id=%s roles=%s",
                    processed.tools_context.session_id,
                    [t.role for t in recording_targets],
                )
            else:
                logger.warning(
                    "backend egress start failed; falling back to local egress roles=%s",
                    [t.role for t in recording_targets],
                )
                await start_recording_egresses(
                    room_name=ctx.room.name,
                    targets=recording_targets,
                )

    bg_kwargs = build_background_player_kwargs(
        background_audio=processed.metadata.config.background_audio,
        tool_call_audio=processed.metadata.config.tool_call_audio,
    )
    if bg_kwargs:
        background_audio = BackgroundAudioPlayer(**bg_kwargs)
        await background_audio.start(room=ctx.room, agent_session=session)


if __name__ == "__main__":
    cli.run_app(server)
