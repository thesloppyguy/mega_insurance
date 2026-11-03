"""Binary wire format for FLAME frames on the ``avatar.flame`` data topic.

Header (little-endian, 26 bytes)::

    4s   magic        b"FLM1"
    12s  turn_id      ASCII, NUL padded
    u32  start_frame  index of the first frame (frame i ↔ audio time i / fps)
    u16  n_frames
    u8   fps
    u8   flags        bit0 = final frame of the turn
    u16  cols         values per frame (104)

Body: ``n_frames × cols`` float16, little-endian, row-major. Columns are
expression[100], jawPose[3], speech gate (0..1).
"""

from __future__ import annotations

import struct

import numpy as np

from .flame_model import FRAME_COLS

FLAME_TOPIC = "avatar.flame"
MAGIC = b"FLM1"
FLAG_FINAL = 0x01
_HEADER = struct.Struct("<4s12sIHBBH")
# Reliable data packets should stay small; 25 frames ≈ 5.2 KB.
MAX_FRAMES_PER_PACKET = 25


def encode_packets(
    turn_id: str,
    start_frame: int,
    frames: np.ndarray,
    fps: float,
    *,
    final: bool = False,
) -> list[bytes]:
    """Split ``frames`` into packets; ``final`` marks the last one."""
    if frames.ndim != 2 or frames.shape[1] != FRAME_COLS:
        raise ValueError(f"frames must be (n, {FRAME_COLS}), got {frames.shape}")
    tid = turn_id.encode("ascii", "replace")[:12]
    out: list[bytes] = []
    n = len(frames)
    if n == 0:
        if final:
            out.append(_HEADER.pack(MAGIC, tid, start_frame, 0, round(fps), FLAG_FINAL, FRAME_COLS))
        return out
    for i in range(0, n, MAX_FRAMES_PER_PACKET):
        chunk = frames[i : i + MAX_FRAMES_PER_PACKET]
        last = i + len(chunk) >= n
        header = _HEADER.pack(
            MAGIC,
            tid,
            start_frame + i,
            len(chunk),
            round(fps),
            FLAG_FINAL if (final and last) else 0,
            FRAME_COLS,
        )
        out.append(header + chunk.astype("<f2").tobytes())
    return out


def decode_packet(data: bytes) -> tuple[str, int, float, bool, np.ndarray]:
    """Inverse of :func:`encode_packets` (used by tests / tooling)."""
    magic, tid, start, n, fps, flags, cols = _HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("bad magic")
    body = np.frombuffer(data, dtype="<f2", offset=_HEADER.size, count=n * cols)
    return (
        tid.rstrip(b"\0").decode("ascii"),
        start,
        float(fps),
        bool(flags & FLAG_FINAL),
        body.reshape(n, cols).astype(np.float32),
    )
