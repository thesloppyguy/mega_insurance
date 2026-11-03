"""Server-side phoneme → FLAME keyframe generation for the OptiModel avatar."""

from .stream import FlameStream
from .wire import FLAME_TOPIC, decode_packet, encode_packets

__all__ = ["FLAME_TOPIC", "FlameStream", "decode_packet", "encode_packets"]
