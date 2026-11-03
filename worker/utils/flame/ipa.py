"""IPA symbol normalisation (mirrors arkit-lipsync/ipa/{inventory,tokenize}.ts)."""

from __future__ import annotations

_IPA_MULTI = (
    "tʃ", "dʒ", "aɪ", "aʊ", "ɔɪ", "eɪ", "oʊ", "əʊ", "ɪə", "eə", "ʊə",
    "ɑː", "ɔː", "iː", "uː", "ɜː", "ɛː", "oː", "æː",
)  # fmt: skip
_IPA_SINGLE = (
    "ɑ", "æ", "ʌ", "ə", "ɚ", "ɝ", "ɛ", "e", "ɪ", "i", "ɔ", "ɒ", "ʊ", "u", "o",
    "a", "p", "b", "t", "d", "k", "g", "ɡ", "m", "n", "ŋ", "f", "v", "θ", "ð",
    "s", "z", "ʃ", "ʒ", "h", "l", "ɫ", "r", "ɹ", "ɾ", "w", "ʍ", "j", "ʝ", "x",
    "c", "ʔ",
)  # fmt: skip

# Longest-first (stable), same as the TS SORTED_INVENTORY.
_SORTED_INVENTORY = sorted((*_IPA_MULTI, *_IPA_SINGLE), key=len, reverse=True)

# Diacritics stripped while tokenising; length marks are kept for inventory matching.
_DIACRITICS = {chr(c) for c in range(0x0300, 0x0370)} | set("ˈˌːˑ.‿|‖↑↓↗↘˞")
_KEEP = {"ː", "ˑ"}


def _extract_stress(symbol: str) -> tuple[str, int]:
    stress = 0
    cleaned = symbol
    if "ˈ" in cleaned or cleaned.endswith("1"):
        stress = 1
    elif "ˌ" in cleaned or cleaned.endswith("2"):
        stress = 2
    cleaned = cleaned.replace("ˈ", "").replace("ˌ", "")
    if cleaned.endswith(("1", "2")):
        cleaned = cleaned[:-1]
    cleaned = "".join(ch for ch in cleaned if ch not in _DIACRITICS or ch in _KEEP)
    return cleaned, stress


def normalize_phone(symbol: str, aliases: dict[str, str]) -> tuple[str, int]:
    """Return ``(canonical_phone, stress)`` for one TTS phone symbol."""
    trimmed = symbol.strip()
    if not trimmed or trimmed == "[silence]":
        return "sil", 0

    cleaned, stress = _extract_stress(trimmed)

    candidate = cleaned
    if aliases.get(candidate):
        candidate = aliases[candidate]

    for entry in _SORTED_INVENTORY:
        if candidate == entry:
            return aliases.get(entry) or entry, stress

    no_length = candidate.replace("ː", "").replace("ˑ", "")
    if aliases.get(no_length):
        return aliases[no_length], stress
    for entry in _SORTED_INVENTORY:
        if no_length == entry:
            return aliases.get(entry) or entry, stress

    if not no_length:
        return "sil", stress
    return aliases.get(no_length) or no_length, stress
