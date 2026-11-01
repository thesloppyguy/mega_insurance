from __future__ import annotations

from typing import Any


class LipsyncBridge:
    """No-op lipsync bridge for ARKit (out of primary Anam path)."""

    def __init__(self, room: Any, *, send_phonemes: bool = False) -> None:
        self.room = room
        self.send_phonemes = send_phonemes

    def attach(self, session: Any) -> None:
        return None

    def detach(self, session: Any) -> None:
        return None
