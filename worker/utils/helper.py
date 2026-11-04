from __future__ import annotations

import logging
import os
from typing import Any

from livekit.agents import JobContext

from utils.backend_client import backend_from_env
from utils.metadata import parse_job_metadata, resolve_session_id

logger = logging.getLogger(__name__)

SESSION_END_STATE: dict[str, dict[str, Any]] = {}


def serialize_history(history: Any) -> dict[str, Any] | None:
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


def serialize_report(report: Any) -> dict[str, Any]:
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


def normalize_usage_payload(usage: Any) -> dict[str, Any] | list[Any] | None:
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


async def on_session_end(ctx: JobContext) -> None:
    """Persist LiveKit session report + Muse underwriting report to the backend."""
    backend = backend_from_env()
    snapshot = SESSION_END_STATE.pop(ctx.job.id, {})
    metadata = parse_job_metadata(ctx.job.metadata)
    session_id = (
        snapshot.get("session_id")
        or resolve_session_id(metadata, fallback=ctx.room.name)
    )
    report_payload: dict[str, Any] = {}
    usage_payload: dict[str, Any] | list[Any] | None = None
    metrics_payload: list[dict[str, Any]] = list(snapshot.get("metrics") or [])

    try:
        report = ctx.make_session_report()
        report_payload = serialize_report(report)
    except Exception:
        logger.exception("make_session_report failed")

    # Prefer chat history snapshot when LiveKit report omits it.
    if isinstance(report_payload, dict) and snapshot.get("history"):
        chat = report_payload.get("chat_history") or report_payload.get("history")
        if not chat:
            report_payload["chat_history"] = snapshot["history"]

    try:
        usage_payload = normalize_usage_payload(
            report_payload.get("usage") if isinstance(report_payload, dict) else None
        )
        if usage_payload is None:
            usage_payload = normalize_usage_payload(snapshot.get("usage"))
    except Exception:
        usage_payload = normalize_usage_payload(snapshot.get("usage"))

    underwriting_report: dict[str, Any] | None = None
    try:
        from utils.muse_report import build_underwriting_report

        session_data = await backend.get_session(session_id) if session_id else None
        underwriting_report = await build_underwriting_report(
            session_id=session_id,
            session_data=session_data or {},
            history=snapshot.get("history") or report_payload.get("chat_history"),
        )
    except Exception:
        logger.exception("muse underwriting report failed")

    if session_id:
        await backend.post_session_report(
            session_id,
            report=report_payload,
            usage=usage_payload,
            metrics=metrics_payload,
            is_final=True,
            underwriting_report=underwriting_report,
        )
        await backend.patch_session_lifecycle(
            session_id,
            status="completed",
            end_reason="completed",
        )
