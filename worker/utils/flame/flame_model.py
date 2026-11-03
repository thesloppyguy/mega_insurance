"""ARKit → FLAME conversion (mirrors packages/arkit-flame/src/{model,filter}.ts)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, fields
from functools import cache
from importlib import resources

import numpy as np

from .arkit import ARKIT2FLAME_CHANNELS, ARKIT_INDEX, SPEECH_BLENDSHAPE_SET

# Per-frame layout shipped to the client: expression[100] + jawPose[3] + gate.
EXPRESSION_DIMS = 100
JAW_DIMS = 3
FLAME_COLS = EXPRESSION_DIMS + JAW_DIMS
FRAME_COLS = FLAME_COLS + 1  # trailing column = speech gate (0..1)

# Rows of the 52-wide ARKit vector feeding the matrix, with non-speech rows zeroed.
_SPEECH_SRC = np.array(
    [ARKIT_INDEX[n] for n in ARKIT2FLAME_CHANNELS], dtype=np.int64
)
_SPEECH_MASK = np.array(
    [n in SPEECH_BLENDSHAPE_SET for n in ARKIT2FLAME_CHANNELS], dtype=np.float32
)
_SPEECH_ROWS = np.array(
    [
        ARKIT_INDEX[n]
        for n in ARKIT2FLAME_CHANNELS
        if n in SPEECH_BLENDSHAPE_SET
    ],
    dtype=np.int64,
)


@dataclass(frozen=True, slots=True)
class FilterParams:
    sigmaFrames: float = 0.75  # noqa: N815 - names mirror arkit2flame-filter.json
    gateLo: float = 0.01  # noqa: N815
    gateHi: float = 0.03  # noqa: N815
    attackSec: float = 0.04  # noqa: N815
    releaseSec: float = 0.15  # noqa: N815
    holdSec: float = 0.08  # noqa: N815
    jawScale: float = 2.15  # noqa: N815
    jawSlewPerFrame: float = 0.028  # noqa: N815
    postJawSigmaFrames: float = 0.35  # noqa: N815
    fps: float = 25.0
    lagFrames: int = 1  # noqa: N815


@dataclass(frozen=True, slots=True)
class FlameModel:
    matrix: np.ndarray  # (rows, cols) float32
    arkit_channels: int
    temporal_radius: int
    rest: np.ndarray  # (103,) expression[100] + jaw[3]
    pca_basis: np.ndarray  # (k, 100)
    pca_mean: np.ndarray  # (100,)

    @property
    def pca_components(self) -> int:
        return int(self.pca_basis.shape[0])


def _read_json(name: str) -> dict:
    return json.loads(
        resources.files(__package__).joinpath(f"assets/{name}").read_text("utf-8")
    )


@cache
def load_model() -> FlameModel:
    j = _read_json("arkit2flame-mat.json")
    rows, cols = int(j["rows"]), int(j["cols"])
    k = int(j.get("pcaComponents", 0))
    if k <= 0:
        raise ValueError("only the PCA ARKit→FLAME matrix is supported")
    channels = int(j.get("arkitChannels", len(ARKIT2FLAME_CHANNELS)))
    radius = max(0, int(j.get("temporalRadius", 0)))
    if channels != len(ARKIT2FLAME_CHANNELS):
        raise ValueError(f"unexpected arkitChannels={channels}")
    if rows != channels * (2 * radius + 1) or cols != k + JAW_DIMS:
        raise ValueError(f"bad matrix shape {rows}x{cols}")
    matrix = np.asarray(j["data"], dtype=np.float32).reshape(rows, cols)
    rest = np.zeros(FLAME_COLS, dtype=np.float32)
    src = j.get("restExpressionJaw") or []
    if len(src) >= FLAME_COLS:
        rest[:] = [v if isinstance(v, (int, float)) and math.isfinite(v) else 0 for v in src[:FLAME_COLS]]
    return FlameModel(
        matrix=matrix,
        arkit_channels=channels,
        temporal_radius=radius,
        rest=rest,
        pca_basis=np.asarray(j["pcaBasis"], dtype=np.float32).reshape(k, EXPRESSION_DIMS),
        pca_mean=np.asarray(j["pcaMean"], dtype=np.float32),
    )


@cache
def load_filter() -> FilterParams:
    j = _read_json("arkit2flame-filter.json")
    src = j.get("best", j)
    kwargs = {}
    for f in fields(FilterParams):
        v = src.get(f.name)
        if isinstance(v, (int, float)) and math.isfinite(v):
            kwargs[f.name] = int(v) if f.name == "lagFrames" else float(v)
    return FilterParams(**kwargs)


def speech_row(weights: np.ndarray) -> np.ndarray:
    """52 ARKit weights → 51-wide matrix input (non-speech channels zeroed)."""
    return weights[_SPEECH_SRC] * _SPEECH_MASK


def speech_energy(weights: np.ndarray) -> float:
    """RMS over the speech channels the matrix was fitted on."""
    v = weights[_SPEECH_ROWS]
    return float(math.sqrt(float(np.dot(v, v)) / len(_SPEECH_ROWS)))


def decode_delta(raw: np.ndarray, model: FlameModel) -> np.ndarray:
    """Matrix output → expression delta[100] + jaw delta[3] (without ``rest``)."""
    k = model.pca_components
    out = np.empty(FLAME_COLS, dtype=np.float64)
    out[:EXPRESSION_DIMS] = model.pca_mean + raw[:k] @ model.pca_basis
    out[EXPRESSION_DIMS:] = raw[k : k + JAW_DIMS]
    return out


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0 if x < edge0 else 1.0
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def ar_approach(prev: float, target: float, dt: float, attack: float, release: float) -> float:
    tau = max(1e-4, attack) if target > prev else max(1e-4, release)
    return prev + (target - prev) * (1 - math.exp(-dt / tau))


def slew_limit(prev: float, nxt: float, max_delta: float) -> float:
    d = nxt - prev
    if d > max_delta:
        return prev + max_delta
    if d < -max_delta:
        return prev - max_delta
    return nxt


def gaussian_kernel(sigma: float) -> np.ndarray | None:
    """Normalised kernel for a zero-phase smooth, or ``None`` when disabled."""
    if sigma <= 1e-6:
        return None
    radius = max(1, math.ceil(sigma * 3))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum()


class SoftSpeechGate:
    """Causal attack/release/hold gate on speech RMS."""

    def __init__(self, params: FilterParams) -> None:
        self._p = params
        self.g = 0.0
        self._hold_left = 0.0

    def step(self, rms: float, dt: float) -> float:
        p = self._p
        target = smoothstep(p.gateLo, p.gateHi, rms)
        if target >= self.g - 1e-9:
            self.g = ar_approach(self.g, target, dt, p.attackSec, p.releaseSec)
            if target > 0.5:
                self._hold_left = p.holdSec
        elif self._hold_left > 0:
            self._hold_left -= dt
        else:
            self.g = ar_approach(self.g, target, dt, p.attackSec, p.releaseSec)
        return self.g
