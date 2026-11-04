"""Resolve and download LiveKit room-composite egress MP4s from S3/R2."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _s3_client():
    import boto3
    from botocore.config import Config

    access = os.getenv("EGRESS_S3_ACCESS_KEY") or ""
    secret = os.getenv("EGRESS_S3_SECRET") or ""
    bucket = os.getenv("EGRESS_S3_BUCKET") or ""
    if not (access and secret and bucket):
        return None, None

    region = os.getenv("EGRESS_S3_REGION") or None
    endpoint = (os.getenv("EGRESS_S3_ENDPOINT") or "").strip() or None
    force_path = (os.getenv("EGRESS_S3_FORCE_PATH_STYLE") or "").lower() in {
        "1",
        "true",
        "yes",
    }
    # Neon certs cover *.storage.…neon.tech only — virtual-hosted
    # {bucket}.{endpoint} adds an extra label and fails TLS.
    if endpoint:
        host = endpoint.split("://", 1)[-1].split("/", 1)[0].lower()
        if ".storage." in host and host.endswith(".neon.tech"):
            force_path = True
    client = boto3.client(
        "s3",
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name=region,
        endpoint_url=endpoint,
        config=Config(s3={"addressing_style": "path" if force_path else "auto"}),
    )
    return client, bucket


def pick_egress_filepath(session_data: dict[str, Any]) -> str | None:
    """Prefer a started room-composite egress path from the session record."""
    rows = session_data.get("egress") or []
    if not isinstance(rows, list):
        return None
    preferred: str | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        path = row.get("filepath")
        if not isinstance(path, str) or not path.strip():
            continue
        status = str(row.get("status") or "").lower()
        role = str(row.get("role") or "").lower()
        if status in {"failed", "error"}:
            continue
        if role in {"room_composite", "composite", ""} or "composite" in role:
            return path.strip()
        preferred = preferred or path.strip()
    return preferred


async def wait_and_download_egress(
    filepath: str,
    *,
    dest_dir: Path | None = None,
    timeout_s: float | None = None,
    poll_s: float = 3.0,
) -> Path | None:
    """
    Poll S3 until the egress object exists, then download to a temp file.

    LiveKit finishes uploading after the room closes, so report generation
    must wait briefly for the MP4 to land.
    """
    client, bucket = await asyncio.to_thread(_s3_client)
    if client is None or not bucket:
        logger.warning("EGRESS_S3_* not configured; cannot download egress video")
        return None

    timeout = timeout_s
    if timeout is None:
        timeout = float(os.getenv("EGRESS_WAIT_SECONDS") or "180")

    from botocore.exceptions import ClientError

    key = filepath.lstrip("/")
    deadline = asyncio.get_running_loop().time() + max(0.0, timeout)
    while True:
        try:
            await asyncio.to_thread(client.head_object, Bucket=bucket, Key=key)
            break
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code") or "")
            if code not in {"404", "NoSuchKey", "NotFound", "403"}:
                logger.info("egress head_object key=%s err=%s", key, exc)
            if asyncio.get_running_loop().time() >= deadline:
                logger.warning(
                    "Timed out waiting for egress object s3://%s/%s", bucket, key
                )
                return None
            await asyncio.sleep(poll_s)
        except Exception as exc:
            logger.info("egress head_object key=%s err=%s", key, exc)
            if asyncio.get_running_loop().time() >= deadline:
                logger.warning(
                    "Timed out waiting for egress object s3://%s/%s", bucket, key
                )
                return None
            await asyncio.sleep(poll_s)

    out_dir = dest_dir or Path(tempfile.mkdtemp(prefix="mavrik-egress-"))
    out_dir.mkdir(parents=True, exist_ok=True)
    local = out_dir / Path(key).name
    try:
        await asyncio.to_thread(client.download_file, bucket, key, str(local))
    except Exception:
        logger.exception("Failed to download egress s3://%s/%s", bucket, key)
        return None
    if not local.is_file() or local.stat().st_size <= 0:
        logger.warning("Downloaded egress file is empty: %s", local)
        return None
    logger.info("Downloaded egress video %s (%s bytes)", local, local.stat().st_size)
    return local


def prepare_sam_clip(
    source: Path,
    *,
    max_seconds: float | None = None,
    target_fps: float | None = None,
) -> Path:
    """
    Optionally downsample/trim the egress MP4 before Meta upload.

    Full interview composites can be long; SAM bills per frame. Default to a
    short, low-fps clip when ffmpeg is available.
    """
    if max_seconds is None:
        max_seconds = float(os.getenv("SAM_VIDEO_MAX_SECONDS") or "90")
    if target_fps is None:
        target_fps = float(os.getenv("SAM_VIDEO_FPS") or "2")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or max_seconds <= 0:
        return source

    out = source.with_name(f"{source.stem}.sam{source.suffix}")
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-t",
        str(max_seconds),
        "-vf",
        f"fps={target_fps}",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-movflags",
        "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=180)
    except Exception:
        logger.exception("ffmpeg downsample failed; using full egress clip")
        return source
    if out.is_file() and out.stat().st_size > 0:
        logger.info(
            "Prepared SAM clip %s (%ss @ %sfps, %s bytes)",
            out.name,
            max_seconds,
            target_fps,
            out.stat().st_size,
        )
        return out
    return source
