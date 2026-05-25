"""Memorable room slug generator shared with the web client."""

from __future__ import annotations

import json
import secrets
from importlib.resources import files
from pathlib import Path

_SUFFIX_MIN = 10
_SUFFIX_MAX = 99


def _load_words() -> tuple[list[str], list[str]]:
    try:
        raw = files("vaux").joinpath("room_slug_words.json").read_text(encoding="utf-8")
    except (FileNotFoundError, TypeError, OSError):
        shared = Path(__file__).resolve().parents[2] / "shared" / "room-slug-words.json"
        raw = shared.read_text(encoding="utf-8")

    data = json.loads(raw)
    return data["adjectives"], data["nouns"]


_ADJECTIVES, _NOUNS = _load_words()


def generate_room_slug() -> str:
    """Return adjective-noun-number slug (e.g. velvet-orbit-42)."""
    adj = _ADJECTIVES[secrets.randbelow(len(_ADJECTIVES))]
    noun = _NOUNS[secrets.randbelow(len(_NOUNS))]
    suffix = secrets.randbelow(_SUFFIX_MAX - _SUFFIX_MIN + 1) + _SUFFIX_MIN
    return f"{adj}-{noun}-{suffix}"
