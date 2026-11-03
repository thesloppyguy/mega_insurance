"""Phonemes → FLAME frames for one speech turn."""

from __future__ import annotations

from typing import Any

import numpy as np

from .baker import FlameBaker
from .flame_model import FRAME_COLS
from .lipsync import LipsyncEvaluator, prepare_phones

# A later phone can still reshape frames up to this far before the last known
# phone's end (overlap blend with a not-yet-seen neighbour), so hold them back.
_SAFETY_S = 0.06
# After the last phone: release of its window plus time for the gate to relax.
_TAIL_S = 0.6


class FlameStream:
    """Feed Inworld ``phoneticDetails`` as they stream in; get FLAME frames out.

    Frame ``i`` describes audio time ``i / fps`` measured from the same origin
    as the phones' ``startTimeSeconds``. Frames are returned once nothing that
    can still arrive is able to change them.
    """

    def __init__(self) -> None:
        self._baker = FlameBaker()
        self._eval = LipsyncEvaluator(self._baker.fps)
        self._finished = False

    @property
    def fps(self) -> float:
        return self._baker.fps

    @property
    def finished(self) -> bool:
        return self._finished

    def add_phonemes(self, details: list[dict[str, Any]]) -> tuple[int, np.ndarray]:
        """Returns ``(first_frame_index, frames[n, FRAME_COLS])`` newly ready."""
        if self._finished:
            return self._baker.emitted, _empty()
        phones = prepare_phones(details)
        if not phones:
            return self._baker.emitted, _empty()
        self._eval.append(phones)
        self._evaluate_until(self._eval.last_end - _SAFETY_S)
        return self._take(self._baker.drain())

    def finish(self) -> tuple[int, np.ndarray]:
        """End of turn: render the tail and flush every remaining frame."""
        if self._finished:
            return self._baker.emitted, _empty()
        self._finished = True
        if self._baker.pushed or self._eval.last_end > 0:
            self._evaluate_until(self._eval.last_end + _TAIL_S)
        return self._take(self._baker.finish())

    def _evaluate_until(self, horizon_s: float) -> None:
        fps = self._baker.fps
        while self._baker.pushed / fps <= horizon_s:
            self._baker.push(self._eval.evaluate(self._baker.pushed / fps))

    def _take(self, frames: np.ndarray) -> tuple[int, np.ndarray]:
        return self._baker.emitted - len(frames), frames


def _empty() -> np.ndarray:
    return np.zeros((0, FRAME_COLS), dtype=np.float32)
