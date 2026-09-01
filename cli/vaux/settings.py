"""Small local-only user settings, persisted across CLI sessions.

Currently just the chosen Textual theme, so LobbyApp and VauxApp (two
separate App instances per session — see main.py's run loop) both start
with the user's last-picked theme instead of resetting to the default.
"""

import json
import os

_SETTINGS_PATH = os.path.join(os.path.expanduser("~/.vaux"), "settings.json")


def load_theme() -> str | None:
    """Returns the saved theme name, or None if unset/unreadable."""
    try:
        with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        theme = data.get("theme")
        return theme if isinstance(theme, str) else None
    except (OSError, ValueError):
        return None


def save_theme(theme_name: str) -> None:
    """Best-effort persist of the chosen theme; failures are silent."""
    data = {}
    try:
        with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, ValueError):
        pass
    data["theme"] = theme_name
    try:
        os.makedirs(os.path.dirname(_SETTINGS_PATH), exist_ok=True)
        with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError:
        pass
