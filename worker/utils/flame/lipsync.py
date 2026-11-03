"""Phoneme → ARKit weight evaluator.

Python port of the browser ``ARKitLipSyncEngine`` + ``CoarticulationEvaluator``
(apps/web/lib/arkit-lipsync). The prep-time phoneme smoother is intentionally
omitted: Inworld phones carry no ``wordIndex``, which makes it a no-op there.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from importlib import resources
from typing import Any

import numpy as np

from .arkit import ARKIT_COUNT, ARKIT_INDEX
from .ipa import normalize_phone

ANTICIPATION_S = 0.04
OVERLAP_S = 0.05
ATTACK_S = 0.03
RELEASE_S = 0.04

# Longest time a phone can influence frames outside [start, end].
_LEAD_S = ANTICIPATION_S + OVERLAP_S * 0.5
_TRAIL_S = RELEASE_S + OVERLAP_S * 0.5

_I = ARKIT_INDEX


def _load_mapping() -> dict[str, Any]:
    raw = resources.files(__package__).joinpath("assets/default_mapping.json")
    return json.loads(raw.read_text(encoding="utf-8"))


_MAPPING = _load_mapping()
_ALIASES: dict[str, str] = _MAPPING.get("aliases", {})
_UNKNOWN_FALLBACK: str = _MAPPING.get("unknownFallback", "sil")


def _smoothstep(t: float) -> float:
    x = min(1.0, max(0.0, t))
    return x * x * (3 - 2 * x)


def _phone_weights(phone: str) -> dict[str, float]:
    key = _ALIASES.get(phone, phone)
    weights = _MAPPING["phones"].get(key)
    if weights is not None:
        return weights
    if _UNKNOWN_FALLBACK in ("neutral", "sil"):
        return {}
    return _MAPPING["phones"].get(_UNKNOWN_FALLBACK, {})


def _to_vector(sparse: dict[str, float]) -> np.ndarray:
    out = np.zeros(ARKIT_COUNT, dtype=np.float32)
    for name, value in sparse.items():
        idx = _I.get(name)
        if idx is not None:
            out[idx] = min(1.0, max(0.0, float(value)))
    return out


def _apply_conflict_constraints(w: np.ndarray) -> None:
    jaw = w[_I["jawOpen"]]
    close = w[_I["mouthClose"]]
    pucker = w[_I["mouthPucker"]]
    funnel = w[_I["mouthFunnel"]]
    stretch_l = w[_I["mouthStretchLeft"]]
    stretch_r = w[_I["mouthStretchRight"]]

    if jaw > 0.15 and close > 0:
        w[_I["mouthClose"]] = min(1.0, max(0.0, close * (1 - jaw * 0.85)))

    rounding = max(pucker, funnel)
    if rounding > 0.2:
        damp = 1 - rounding * 0.7
        w[_I["mouthStretchLeft"]] = min(1.0, max(0.0, stretch_l * damp))
        w[_I["mouthStretchRight"]] = min(1.0, max(0.0, stretch_r * damp))

    stretch = max(stretch_l, stretch_r)
    if stretch > 0.35:
        damp = 1 - stretch * 0.5
        w[_I["mouthPucker"]] = min(1.0, max(0.0, pucker * damp))
        w[_I["mouthFunnel"]] = min(1.0, max(0.0, funnel * damp))


@dataclass(slots=True)
class PreparedPhone:
    start: float
    end: float
    weights: np.ndarray


def prepare_phones(details: list[dict[str, Any]]) -> list[PreparedPhone]:
    """Inworld ``phoneticDetails`` → sorted, weight-resolved phones."""
    raw: list[tuple[float, float, str]] = []
    for detail in details:
        for phone in detail.get("phones") or []:
            symbol = str(phone.get("phoneSymbol") or "")
            start = float(phone.get("startTimeSeconds") or 0.0)
            duration = float(phone.get("durationSeconds") or 0.0)
            if duration <= 0 and symbol in ("[silence]", "sil"):
                continue
            if not math.isfinite(start):
                start = 0.0
            if not math.isfinite(duration):
                duration = 0.0
            raw.append((start, start + max(duration, 0.001), symbol))
    raw.sort(key=lambda p: (p[0], p[1]))

    out: list[PreparedPhone] = []
    for start, end, symbol in raw:
        phone, stress = normalize_phone(symbol, _ALIASES)
        w = _to_vector(_phone_weights(phone))
        if stress == 1:
            w[_I["jawOpen"]] = min(1.0, w[_I["jawOpen"]] * 1.12)
        out.append(PreparedPhone(start, end, w))
    return out


class LipsyncEvaluator:
    """Streaming-friendly evaluator: append phones, evaluate at audio time ``t``."""

    def __init__(self, fps: float) -> None:
        self._phones: list[PreparedPhone] = []
        self._lo = 0
        # The browser ran its jaw follow-through at ~60 Hz (alpha 0.15/tick);
        # keep the same time constant at our frame rate.
        self._jaw_alpha = 1 - 0.85 ** (60.0 / fps)
        self._jaw_lag = 0.0

    @property
    def last_end(self) -> float:
        return max((p.end for p in self._phones[-8:]), default=0.0)

    def append(self, phones: list[PreparedPhone]) -> None:
        if not phones:
            return
        in_order = not self._phones or phones[0].start >= self._phones[-1].start
        self._phones.extend(phones)
        if not in_order:
            self._phones.sort(key=lambda p: (p.start, p.end))
            self._lo = 0

    def evaluate(self, t: float) -> np.ndarray:
        """ARKit weights (52) for audio time ``t`` (seconds)."""
        phones = self._phones
        acc = np.zeros(ARKIT_COUNT, dtype=np.float32)
        total = 0.0

        while self._lo < len(phones) and phones[self._lo].end + _TRAIL_S < t:
            self._lo += 1

        for i in range(self._lo, len(phones)):
            p = phones[i]
            if p.start - _LEAD_S > t:
                break
            prev = phones[i - 1] if i > 0 else None
            nxt = phones[i + 1] if i + 1 < len(phones) else None

            win_start = p.start - ANTICIPATION_S - (OVERLAP_S * 0.5 if prev else 0)
            win_end = p.end + RELEASE_S + (OVERLAP_S * 0.5 if nxt else 0)
            if t < win_start or t > win_end:
                continue

            attack_end = p.start + min(ATTACK_S, max(0.001, (p.end - p.start) * 0.35))
            if t < p.start:
                u = (t - win_start) / max(1e-4, p.start - win_start)
                influence = _smoothstep(u) * 0.65
            elif t < attack_end:
                u = (t - p.start) / max(1e-4, attack_end - p.start)
                influence = _smoothstep(u)
            elif t <= p.end:
                influence = 1.0
                if nxt is not None and t > p.end - OVERLAP_S:
                    u = (p.end - t) / max(1e-4, OVERLAP_S)
                    influence = 0.5 + 0.5 * _smoothstep(u)
            else:
                u = 1 - (t - p.end) / max(1e-4, win_end - p.end)
                influence = _smoothstep(u)

            if influence <= 1e-4:
                continue
            acc += p.weights * influence
            total += influence

        out = np.zeros(ARKIT_COUNT, dtype=np.float32)
        if total > 1e-6:
            norm = 1.15 / total if total > 1.15 else 1.0
            out = np.clip(acc * norm, 0.0, 1.0).astype(np.float32)
            _apply_conflict_constraints(out)
        return self._add_speech_life(out, t)

    def _add_speech_life(self, w: np.ndarray, t: float) -> np.ndarray:
        """Secondary motion on top of the pose; silence stays neutral."""
        jaw = float(w[_I["jawOpen"]])
        self._jaw_lag += (jaw - self._jaw_lag) * self._jaw_alpha
        if jaw < 0.03 and self._jaw_lag < 0.03:
            return w

        noise = 0.5 * (math.sin(t * 7.3) + math.sin(t * 11.1 + 1.3))
        w[_I["jawOpen"]] = min(1.0, max(0.0, jaw + 0.02 * noise * min(1.0, jaw * 3)))

        def bump(name: str, v: float) -> None:
            i = _I[name]
            w[i] = min(1.0, max(0.0, max(float(w[i]), v)))

        speaking = min(1.0, jaw * 4)
        bump("cheekSquintLeft", 0.12 * self._jaw_lag)
        bump("cheekSquintRight", 0.12 * self._jaw_lag)
        bump("mouthSmileLeft", 0.04 * speaking)
        bump("mouthSmileRight", 0.04 * speaking)
        bump("browInnerUp", min(0.1, max(0.0, jaw - self._jaw_lag) * 0.4))
        return w
