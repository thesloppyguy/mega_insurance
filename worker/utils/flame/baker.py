"""Incremental, zero-phase ARKit → FLAME bake.

The browser could only run this causally (edge-padded windows, a few frames of
lag). The worker knows the utterance ahead of playback, so we reproduce the
offline ``bakeArkitFlameFiltered`` pipeline instead, emitting a frame as soon
as every frame it depends on exists:

    raw ARKit ─gaussian→ smoothed ─(window ±R, lag)→ matrix → delta
              └ gate (causal, on raw energy)            └ jaw0 post-smooth
    frame = rest + gate·delta, jaw0 slew-limited

Calling ``finish()`` edge-replicates the tail and flushes everything.
"""

from __future__ import annotations

import numpy as np

from .arkit import ARKIT_COUNT
from .flame_model import (
    EXPRESSION_DIMS,
    FRAME_COLS,
    FilterParams,
    FlameModel,
    SoftSpeechGate,
    decode_delta,
    gaussian_kernel,
    load_filter,
    load_model,
    slew_limit,
    speech_energy,
    speech_row,
)


class FlameBaker:
    def __init__(
        self,
        model: FlameModel | None = None,
        params: FilterParams | None = None,
    ) -> None:
        self.model = model or load_model()
        self.params = params or load_filter()
        p = self.params
        self._fps = p.fps
        self._lag = max(0, int(p.lagFrames))
        self._radius = self.model.temporal_radius

        self._k_arkit = gaussian_kernel(p.sigmaFrames)
        self._k_jaw = gaussian_kernel(p.postJawSigmaFrames)
        self._r_arkit = 0 if self._k_arkit is None else len(self._k_arkit) // 2
        self._r_jaw = 0 if self._k_jaw is None else len(self._k_jaw) // 2

        self._gate = SoftSpeechGate(p)
        self._weights: list[np.ndarray] = []  # raw ARKit, 52
        self._smoothed: list[np.ndarray] = []  # 51-wide matrix rows
        self._delta: list[np.ndarray] = []  # 103 (expr delta + jaw delta)
        self._gates: list[float] = []
        self._jaw0: list[float] = []  # post-smoothed jaw0 delta
        self._emitted = 0
        self._prev_jaw0 = float(self.model.rest[EXPRESSION_DIMS])
        self._finished = False

    @property
    def fps(self) -> float:
        return self._fps

    @property
    def emitted(self) -> int:
        """Number of frames already returned."""
        return self._emitted

    @property
    def pushed(self) -> int:
        return len(self._weights)

    def push(self, weights: np.ndarray) -> None:
        """Append the raw ARKit weights (52) for frame ``pushed``."""
        if self._finished:
            raise RuntimeError("baker already finished")
        w = np.asarray(weights, dtype=np.float32)
        if w.shape != (ARKIT_COUNT,):
            raise ValueError(f"expected {ARKIT_COUNT} weights, got {w.shape}")
        self._weights.append(w)
        self._gates.append(
            self._gate.step(speech_energy(w), 1.0 / self._fps)
        )

    def finish(self) -> np.ndarray:
        """Flush the remaining frames (edge-replicating the tail)."""
        self._finished = True
        return self._drain(final=True)

    def drain(self) -> np.ndarray:
        """Frames that no longer depend on future input, shape (n, FRAME_COLS)."""
        return self._drain(final=False)

    # ------------------------------------------------------------------ stages

    def _drain(self, *, final: bool) -> np.ndarray:
        self._advance_smoothed(final)
        self._advance_delta(final)
        self._advance_jaw(final)
        return self._emit()

    def _advance_smoothed(self, final: bool) -> None:
        n = len(self._weights)
        ready = n if final else max(0, n - self._r_arkit)
        while len(self._smoothed) < ready:
            i = len(self._smoothed)
            if self._k_arkit is None:
                self._smoothed.append(speech_row(self._weights[i]))
                continue
            r = self._r_arkit
            idx = np.clip(np.arange(i - r, i + r + 1), 0, n - 1)
            stack = np.stack([self._weights[j] for j in idx])  # (2r+1, 52)
            sm = (self._k_arkit[:, None] * stack).sum(axis=0)
            self._smoothed.append(speech_row(sm.astype(np.float32)))

    def _advance_delta(self, final: bool) -> None:
        m = len(self._smoothed)
        R, lag = self._radius, self._lag
        ready = m if final else min(m, max(0, m - R + lag))
        n = m
        while len(self._delta) < ready:
            t = len(self._delta)
            src = max(0, t - lag)
            rows = [
                self._smoothed[min(n - 1, max(0, src - R + k))]
                for k in range(2 * R + 1)
            ]
            raw = np.concatenate(rows) @ self.model.matrix
            self._delta.append(decode_delta(raw, self.model))

    def _advance_jaw(self, final: bool) -> None:
        m = len(self._delta)
        ready = m if final or self._k_jaw is None else max(0, m - self._r_jaw)
        n = m
        while len(self._jaw0) < ready:
            t = len(self._jaw0)
            if self._k_jaw is None:
                self._jaw0.append(float(self._delta[t][EXPRESSION_DIMS]))
                continue
            r = self._r_jaw
            vals = np.array(
                [
                    self._delta[min(n - 1, max(0, t + k))][EXPRESSION_DIMS]
                    for k in range(-r, r + 1)
                ]
            )
            self._jaw0.append(float(self._k_jaw @ vals))

    def _emit(self) -> np.ndarray:
        rest = self.model.rest
        p = self.params
        start, end = self._emitted, len(self._jaw0)
        out = np.zeros((max(0, end - start), FRAME_COLS), dtype=np.float32)
        for row, t in enumerate(range(start, end)):
            g = self._gates[t]
            d = self._delta[t]
            frame = out[row]
            frame[:EXPRESSION_DIMS] = rest[:EXPRESSION_DIMS] + g * d[:EXPRESSION_DIMS]
            jaw0 = float(rest[EXPRESSION_DIMS]) + p.jawScale * g * self._jaw0[t]
            jaw0 = slew_limit(self._prev_jaw0, jaw0, p.jawSlewPerFrame)
            self._prev_jaw0 = jaw0
            frame[EXPRESSION_DIMS] = jaw0
            frame[EXPRESSION_DIMS + 1] = rest[EXPRESSION_DIMS + 1] + p.jawScale * g * d[EXPRESSION_DIMS + 1]
            frame[EXPRESSION_DIMS + 2] = rest[EXPRESSION_DIMS + 2] + p.jawScale * g * d[EXPRESSION_DIMS + 2]
            frame[EXPRESSION_DIMS + 3] = g
        self._emitted = end
        np.nan_to_num(out, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        return out
