"""
VauxApp — the main Textual application.

Layout (single screen):
┌─────────────────────────────────────────────┐
│  header: vaux / room-id          role·name  │
├───────────────────────┬─────────────────────┤
│                       │  now playing        │
│   queue               │  ─────────────────  │
│                       │  chat               │
│                       │  ─────────────────  │
│   search results      │  chat input         │
├───────────────────────┴─────────────────────┤
│  search input                [Search]        │
└─────────────────────────────────────────────┘
"""

import asyncio
import os
import re
import sys
import json
import socket
import pyperclip
from importlib.metadata import PackageNotFoundError, version
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import (
    Header, Footer, Input, Button, Label, ListView,
    ListItem, Static, RichLog,
)
from textual.reactive import reactive
from rich.text import Text
import unicodedata


def _cell_len(text: str) -> int:
    """Approximate terminal cell width. CJK / fullwidth glyphs count as 2,
    combining marks as 0, everything else as 1. Good enough for budgeting
    the now-playing line without depending on internal rich APIs."""
    width = 0
    for ch in text:
        if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def _truncate_cells(text: str, max_cells: int) -> str:
    """Truncate `text` so it occupies at most `max_cells` terminal columns,
    counted via _cell_len."""
    if max_cells <= 0:
        return ""
    width = 0
    out: list[str] = []
    for ch in text:
        if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            out.append(ch)
            continue
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if width + w > max_cells:
            break
        out.append(ch)
        width += w
    return "".join(out)

from vaux.socket_client import VauxSocket, probe_join
from vaux.playback import PlaybackState
from vaux.api import search_youtube, SearchResult, get_stream_url, ping_server
from vaux.mpv import find_mpv
from vaux.room_slug import generate_room_slug
from vaux.crypto import (
    RoomMaterial,
    auth_proof_to_b64,
    decrypt_chat,
    derive_room_material,
    encrypt_chat,
    generate_password,
    is_well_formed_password,
    parse_invite,
)
from dataclasses import dataclass

@dataclass
class LobbySelection:
    """What LobbyApp returns to main.py. `private` material is None for
    public rooms; populated for private rooms so VauxApp can encrypt/decrypt
    without re-deriving (Argon2id is ~250 ms — only do it once per session)."""

    room_id: str
    username: str
    is_private: bool = False
    auth_proof_b64: str = ""
    chat_key: bytes = b""
    password: str = ""  # kept in-memory for in-room "copy invite link"
    create: bool = False  # True only for private-create flow

import subprocess

# Stable per-user palette. userId is hashed deterministically (matches the
# web client's hash) so the same person gets the same color across both
# clients, and two users sharing a display name still render in different
# colors. Six colors keeps small rooms unambiguous.
CHAT_COLORS = (
    "#52d4a0",
    "#f0c54f",
    "#7ec8e3",
    "#e07fc4",
    "#ff8a5b",
    "#a685e2",
)


def color_for_user(user_id: str) -> str:
    if not user_id:
        return CHAT_COLORS[0]
    idx = sum(ord(c) for c in user_id) % len(CHAT_COLORS)
    return CHAT_COLORS[idx]

class MPVPlayer:
    def __init__(self, path: str):
        self.path = path
        self.proc = None
        self.ipc_path = r"\\.\pipe\vaux_mpv_ipc" if sys.platform == "win32" else "/tmp/vaux_mpv_ipc"

    def play(self, url: str, start: float = 0.0, volume: int = 100):
        self.stop()
        
        if sys.platform != "win32" and os.path.exists(self.ipc_path):
            try: os.remove(self.ipc_path)
            except OSError: pass
        
        cmd = [
            self.path,
            "--no-video",
            f"--start={int(start)}",
            f"--volume={volume}",
            f"--input-ipc-server={self.ipc_path}",
            url,
        ]
        
        kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            
        self.proc = subprocess.Popen(cmd, **kwargs)

    def _send_ipc(self, command: dict) -> None:
        """Sends a JSON-IPC command to the running mpv. Silently fails if mpv
        isn't up yet or the pipe/socket isn't ready — callers don't need to
        care, since any future state-sync broadcast will retry."""
        payload = json.dumps(command) + "\n"
        try:
            if sys.platform == "win32":
                with open(self.ipc_path, "w") as f:
                    f.write(payload)
                    f.flush()
            else:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(self.ipc_path)
                s.sendall(payload.encode())
                s.close()
        except Exception:
            pass

    def set_volume(self, volume: int):
        self._send_ipc({"command": ["set_property", "volume", volume]})

    def seek(self, position_seconds: float):
        """Jumps to an absolute position in the current track via mpv IPC.
        Used to mirror host scrubbing without restarting the player (which
        would re-buffer and create an audio gap)."""
        self._send_ipc(
            {"command": ["seek", float(position_seconds), "absolute"]}
        )

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc = None


# ── LobbyApp ──────────────────────────────────────────────────────────────
# Pre-join screen: create or join a room, then return room_id + username via self.result.

LOBBY_TITLE = r"""____   _________   ____ _______  ___
\   \ /   /  _  \ |    |   \   \/  /
 \   Y   /  /_\  \|    |   /\     / 
  \     /    |    \    |  / /     \ 
   \___/\____|__  /______/ /___/\  \
                \/               \_/"""
LOBBY_TITLE_COMPACT = "VAUX"
LOBBY_TITLE_MIN_WIDTH = 46  # terminal cols below which we fall back to compact title

try:
    APP_VERSION = version("vaux-cli")
except PackageNotFoundError:
    APP_VERSION = "dev"

APP_AUTHOR = "Violet Nguyen (Vee)"
APP_WEBSITE = "https://itsvee0120.github.io/violet-website/"
APP_GITHUB = "https://github.com/itsvee0120/vaux"
APP_PYPI = "https://pypi.org/project/vaux-cli/"
APP_RELEASES = f"{APP_GITHUB}/releases"


BUG_REPORT_GOOGLE_FORM_URL = "https://forms.gle/VrwxwGgHUMLNPSfQA"

# Parent tracking issue for all reported bugs.
BUG_REPORT_PARENT_ISSUE = 36


def build_github_issue_url(in_room: bool) -> str:
    """Returns a GitHub new-issue URL pre-filled with env info + a template body."""
    import platform
    import urllib.parse

    body = (
        f"Parent issue: {APP_GITHUB}/issues/{BUG_REPORT_PARENT_ISSUE}\n"
        "<!-- maintainer: please link this report as a sub-issue of "
        f"#{BUG_REPORT_PARENT_ISSUE} via the parent's Sub-issues panel. -->\n\n"
        "## What happened?\n\n\n"
        "## Steps to reproduce\n1. \n2. \n3. \n\n"
        "## Expected behavior\n\n\n"
        "## ScreenShots or Media\n\n\n"
        "---\n"
        f"vaux-cli: {APP_VERSION}\n"
        f"Python: {sys.version.split()[0]}\n"
        f"OS: {platform.platform()}\n"
        f"Context: {'in-room' if in_room else 'lobby'}\n"
    )
    params = urllib.parse.urlencode({"title": "[CLI - BUG REPORT] ", "body": body, "labels": "bug"})
    return f"{APP_GITHUB}/issues/new?{params}"


def _build_app_info(in_room: bool) -> str:
    lines = [
        "listen together, in sync",
        "audio may lag 5–10s on first play or skip, syncs automatically after",
        "",
        f"Version   {APP_VERSION}",
        f"Author    {APP_AUTHOR}",
        "",
        "Links",
        f"  Website:   {APP_WEBSITE}",
        f"  GitHub:    {APP_GITHUB}",
        f"  Releases:  {APP_RELEASES}",
        f"  PyPI:      {APP_PYPI}",
    ]
    if in_room:
        lines.extend([
            "",
            "Shortcuts",
            "  ctrl+s   search",
            "  ctrl+r   clear search results",
            "  ctrl+t   chat",
            "  ctrl+o   play / pause  (host)",
            "  ctrl+n   skip track    (host)",
            "  delete/x remove queue track (host, queue focused)",
            "  ctrl+u   vote up",
            "  ctrl+d   vote down",
            "  - / =    volume down / up",
            "  m        mute / unmute",
            "  ctrl+k   copy room name",
            "  ↑ / ↓    chat history (chat focused)",
            "  ctrl+g   this screen, hit esc to close",
            "  ctrl+l   view listeners & transfer host (host)",
            "  ctrl+b   report a bug",
            "  ctrl+p   command palette (save screenshot, etc.)",
            "  ctrl+c   quit",
            "  type '/host <username>' to transfer host",
        ])
    else:
        lines.extend([
            "",
            "Shortcuts",
            "  tab      next field",
            "  ctrl+g   this screen, hit esc to close",
            "  ctrl+b   report a bug",
            "  ctrl+p   command palette (save screenshot, etc.)",
            "  ctrl+c   quit",
        ])
    return "\n".join(lines)


class InfoModal(ModalScreen[None]):
    """About screen: version, author, links, and key bindings."""

    DEFAULT_CSS = """
    InfoModal {
        align: center middle;
    }

    #info-dialog {
        width: 62;
        max-width: 95%;
        height: auto;
        max-height: 90%;
        overflow-y: auto;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }

    #info-title {
        text-align: center;
        color: $success;
        text-style: bold;
        margin-bottom: 1;
    }

    #info-text {
        height: auto;
        margin-bottom: 1;
    }

    #info-close {
        dock: bottom;
        width: 100%;
        margin-top: 1;
    }
    """

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
    ]

    def __init__(self, in_room: bool = False):
        super().__init__()
        self.in_room = in_room

    def compose(self) -> ComposeResult:
        with Vertical(id="info-dialog"):
            yield Label("VAUX", id="info-title")
            yield Static(_build_app_info(self.in_room), id="info-text")
            yield Button("Close", id="info-close", variant="primary")

    def action_dismiss(self) -> None:
        self.dismiss()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "info-close":
            self.dismiss()


class BugReportModal(ModalScreen[None]):
    """Overlay for filing a bug — Google Form (anonymous) or GitHub Issues."""

    DEFAULT_CSS = """
    BugReportModal {
        align: center middle;
    }

    #bug-dialog {
        width: 64;
        max-width: 95%;
        height: auto;
        max-height: 90%;
        overflow-y: auto;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }

    #bug-title {
        text-align: center;
        color: $success;
        text-style: bold;
        margin-bottom: 1;
    }

    #bug-text {
        height: auto;
        margin-bottom: 1;
    }

    #bug-buttons {
        height: auto;
        margin-bottom: 1;
    }

    #bug-buttons Button {
        width: 1fr;
        margin: 0 1;
    }

    #bug-note {
        height: auto;
        color: $text-muted;
        margin-bottom: 1;
    }

    #bug-close {
        width: 100%;
    }
    """

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
    ]

    def __init__(self, in_room: bool = False):
        super().__init__()
        self.in_room = in_room

    def compose(self) -> ComposeResult:
        with Vertical(id="bug-dialog"):
            yield Label("Report a bug", id="bug-title")
            yield Static(
                "Pick how you'd like to file this report:",
                id="bug-text",
            )
            with Horizontal(id="bug-buttons"):
                yield Button(
                    "Google Form",
                    id="bug-google",
                    variant="success",
                    disabled=not BUG_REPORT_GOOGLE_FORM_URL,
                )
                yield Button(
                    "GitHub Issues",
                    id="bug-github",
                    variant="primary",
                )
            yield Static(
                "Tip: close this overlay, then press [b]Ctrl+P[/b] to open the\n"
                "command palette and choose [b]Save screenshot[/b] — vaux will write an SVG of the current screen.\n"
                "You can attach it to your report.\n\n"
                "[b]Security note:[/b] If this issue involves sensitive security concerns, please use the official Google Form instead of submitting it through GitHub issues.",
                id="bug-note",
            )
            yield Button("Close", id="bug-close")

    def action_dismiss(self) -> None:
        self.dismiss()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        import webbrowser

        bid = event.button.id
        if bid == "bug-close":
            self.dismiss()
            return

        if bid == "bug-google":
            if not BUG_REPORT_GOOGLE_FORM_URL:
                return
            webbrowser.open(BUG_REPORT_GOOGLE_FORM_URL)
            self.dismiss()
            return

        if bid == "bug-github":
            webbrowser.open(build_github_issue_url(self.in_room))
            self.dismiss()
            return


class ListenersModal(ModalScreen[None]):
    """Host-only view of everyone in the room."""

    DEFAULT_CSS = """
    ListenersModal {
        align: center middle;
    }

    #listeners-dialog {
        width: 56;
        max-width: 95%;
        height: auto;
        max-height: 80%;
        overflow-y: auto;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }

    #listeners-title {
        text-align: center;
        color: $success;
        text-style: bold;
        margin-bottom: 1;
    }

    .listener-row {
        height: 3;
        margin-bottom: 1;
    }

    .listener-row Label {
        width: 1fr;
        content-align: left middle;
    }

    #listeners-close {
        width: 100%;
        margin-top: 1;
    }
    """

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
    ]

    def __init__(self, members: list[dict], on_make_host):
        super().__init__()
        self.members = members
        self.on_make_host = on_make_host

    def compose(self) -> ComposeResult:
        listeners = [m for m in self.members if m.get("role") != "host"]
        host = next((m for m in self.members if m.get("role") == "host"), None)

        with Vertical(id="listeners-dialog"):
            yield Label("Listeners", id="listeners-title")
            if host:
                yield Label(f"⭐ {host['username']} (host)")
            if not listeners:
                yield Static("No listeners in the room yet.")
            else:
                for member in listeners:
                    with Horizontal(classes="listener-row"):
                        yield Label(member.get("username", member.get("userId", "?")))
                        yield Button(
                            "make host",
                            id=f"host-{member['userId']}",
                            variant="default",
                        )
            yield Button("Close", id="listeners-close", variant="primary")

    def action_dismiss(self) -> None:
        self.dismiss()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "listeners-close":
            self.dismiss()
        elif event.button.id.startswith("host-"):
            user_id = event.button.id.removeprefix("host-")
            asyncio.create_task(self._transfer_host(user_id))

    async def _transfer_host(self, user_id: str) -> None:
        await self.on_make_host(user_id)
        self.dismiss()


class LobbyApp(App):
    """Pre-game lobby: create a room (slug) or join an existing one."""

    CSS = """
    Screen {
        align: center middle;
    }

    #card {
        width: auto;
        max-width: 60;
        min-width: 36;
        border: round $primary;
        padding: 1 2;
    }

    #title {
        text-align: center;
        color: $success;
        text-style: bold;
        margin-bottom: 1;
        height: auto;
        width: 100%;
    }

    #slug-row {
        layout: horizontal;
        height: 3;
        margin-bottom: 1;
    }

    #slug-display {
        width: 1fr;
        color: $success;
        content-align: left middle;
        padding: 0 1;
        border: tall $primary-darken-2;
    }

    #reroll-btn {
        width: 10;
        margin-left: 1;
    }

    #copy-btn {
        width: auto;
        min-width: 2;
        max-width: 4;
        margin-left: 1;
        padding: 0;
    }

    #mode-row {
        layout: horizontal;
        height: 3;
        margin-bottom: 1;
    }

    #create-btn, #join-btn, #private-btn {
        width: 1fr;
    }

    #priv-row {
        layout: horizontal;
        height: 3;
        margin-bottom: 1;
    }

    #priv-new-btn, #priv-paste-btn {
        width: 1fr;
    }

    #room-input-row {
        layout: horizontal;
        height: 3;
        margin-bottom: 1;
        text-align: center;
    }

    #room-input {
        width: 1fr;
    }

    #paste-btn {
        width: 10;
        margin-left: 1;
    }

    #username-input {
        margin-bottom: 1;
    }

    #go-btn {
        width: 100%;
    }

    #hint {
        /* Stretch to the card's full width so `text-align: center` actually
           centers — without this, Label auto-sizes to its text and the
           centered text sits inside a left-aligned box. */
        width: 100%;
        text-align: center;
        color: $text-muted;
        margin-top: 1;
    }

    #audio-note {
        text-align: center;
        color: $text-muted;
        text-style: italic;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+g", "info", "Info", show=True),
        Binding("ctrl+b", "report_bug", "Bug", show=True),
        Binding("tab", "focus_next", "Next field", show=False),
    ]

    def __init__(
        self,
        server_url: str,
        *,
        initial_invite: str | None = None,
        initial_error: str | None = None,
    ):
        super().__init__()
        self.server_url = server_url
        self._initial_error = initial_error
        # _mode ∈ {"create", "join", "private_create", "private_paste"}.
        # Sole entry from main.py for invite URLs lands us in "private_paste"
        # with the password pre-filled — same UX as the web client.
        if initial_invite and is_well_formed_password(initial_invite):
            self._mode = "private_paste"
            self._initial_invite = initial_invite
        else:
            self._mode = "create"
            self._initial_invite = None
        self._slug = generate_room_slug()
        self._private_password = generate_password()
        self.result: LobbySelection | None = None

    def compose(self) -> ComposeResult:
        with Vertical(id="card"):
            yield Label(LOBBY_TITLE, id="title")

            with Horizontal(id="mode-row"):
                yield Button("create room", id="create-btn", variant="success")
                yield Button("join room",   id="join-btn",   variant="default")
                yield Button("🔒 private",  id="private-btn", variant="default")

            with Horizontal(id="priv-row"):
                yield Button("new room",     id="priv-new-btn",   variant="success")
                yield Button("paste invite", id="priv-paste-btn", variant="default")

            with Horizontal(id="slug-row"):
                yield Label(self._slug, id="slug-display")
                yield Button("↺ new", id="reroll-btn", variant="default")
                yield Button("📋", id="copy-btn", variant="default")

            with Horizontal(id="room-input-row"):
                yield Input(placeholder="room name (e.g. velvet-orbit-42)", id="room-input")
                yield Button("paste", id="paste-btn", variant="default")

            yield Input(placeholder="your name", id="username-input")
            yield Button("create & join →", id="go-btn", variant="success")
            yield Label("", id="hint")
            yield Static(
                "Audio may take 5–10s on first play or skip · syncs automatically after",
                id="audio-note",
            )

        yield Footer()

    def on_mount(self):
        self._apply_mode()
        self._apply_title()
        asyncio.create_task(ping_server(self.server_url))
        if self._initial_error:
            # Surfaced from a failed VauxApp join — replaces whatever default
            # hint _apply_mode set so the user sees why they bounced back.
            self.query_one("#hint", Label).update(
                f"[red]{self._initial_error}[/red]"
            )
            self.notify(self._initial_error, severity="error", timeout=8)
            self._initial_error = None

    def on_resize(self, event) -> None:
        self._apply_title()

    def _apply_title(self) -> None:
        try:
            title = self.query_one("#title", Label)
        except Exception:
            return
        if self.size.width < LOBBY_TITLE_MIN_WIDTH:
            title.update(LOBBY_TITLE_COMPACT)
        else:
            title.update(LOBBY_TITLE)

    def _apply_mode(self):
        slug_row   = self.query_one("#slug-row")
        slug_display = self.query_one("#slug-display", Label)
        priv_row   = self.query_one("#priv-row")
        room_input_row = self.query_one("#room-input-row")
        room_input = self.query_one("#room-input", Input)
        go_btn     = self.query_one("#go-btn", Button)
        hint       = self.query_one("#hint", Label)
        create_btn = self.query_one("#create-btn", Button)
        join_btn   = self.query_one("#join-btn", Button)
        private_btn = self.query_one("#private-btn", Button)
        copy_btn   = self.query_one("#copy-btn", Button)
        reroll_btn = self.query_one("#reroll-btn", Button)
        paste_btn  = self.query_one("#paste-btn", Button)
        priv_new_btn = self.query_one("#priv-new-btn", Button)
        priv_paste_btn = self.query_one("#priv-paste-btn", Button)

        is_private = self._mode.startswith("private")
        create_btn.variant = "success" if self._mode == "create" else "default"
        join_btn.variant   = "success" if self._mode == "join" else "default"
        private_btn.variant = "success" if is_private else "default"

        priv_row.display = is_private
        priv_new_btn.variant = (
            "success" if self._mode == "private_create" else "default"
        )
        priv_paste_btn.variant = (
            "success" if self._mode == "private_paste" else "default"
        )

        if self._mode == "create":
            slug_row.display   = True
            slug_display.update(self._slug)
            reroll_btn.display = True
            copy_btn.display   = True
            room_input_row.display = False
            paste_btn.display  = False
            go_btn.label       = "create & join →"
            hint.update("Copy the room name to share with others 📋")

        elif self._mode == "join":
            slug_row.display   = False
            room_input_row.display = True
            copy_btn.display   = False
            paste_btn.display  = True
            room_input.placeholder = "room name (e.g. velvet-orbit-42)"
            go_btn.label       = "join room →"
            hint.update("Ask the host for their room name")
            room_input.focus()

        elif self._mode == "private_create":
            slug_row.display   = True
            slug_display.update(self._private_password)
            reroll_btn.display = True
            copy_btn.display   = True
            room_input_row.display = False
            paste_btn.display  = False
            go_btn.label       = "create private room →"
            hint.update("Share the code 📋 — chat is end-to-end encrypted")

        elif self._mode == "private_paste":
            slug_row.display   = False
            room_input_row.display = True
            copy_btn.display   = False
            paste_btn.display  = True
            room_input.placeholder = "paste invite link or password"
            go_btn.label       = "join private room →"
            hint.update("Paste the invite URL or 22-char code")
            if self._initial_invite:
                room_input.value = self._initial_invite
                self._initial_invite = None
            room_input.focus()

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id

        if btn_id == "create-btn":
            self._mode = "create"
            self._apply_mode()

        elif btn_id == "join-btn":
            self._mode = "join"
            self._apply_mode()

        elif btn_id == "private-btn":
            # First click defaults to "new private". Subsequent clicks while
            # already in private leave the sub-mode alone (user picks via
            # priv-row buttons).
            if not self._mode.startswith("private"):
                self._mode = "private_create"
                self._apply_mode()

        elif btn_id == "priv-new-btn":
            self._mode = "private_create"
            self._apply_mode()

        elif btn_id == "priv-paste-btn":
            self._mode = "private_paste"
            self._apply_mode()

        elif btn_id == "reroll-btn":
            if self._mode == "private_create":
                self._private_password = generate_password()
                self.query_one("#slug-display", Label).update(self._private_password)
            else:
                self._slug = generate_room_slug()
                self.query_one("#slug-display", Label).update(self._slug)

        elif btn_id == "go-btn":
            self._submit()

        elif btn_id == "copy-btn":
            self._copy_slug()

        elif btn_id == "paste-btn":
            self._paste_slug()

    def _copy_slug(self):
        if self._mode == "private_create":
            pyperclip.copy(self._private_password)
            self.query_one("#hint", Label).update("Code copied — share it privately")
        else:
            pyperclip.copy(self._slug)
            self.query_one("#hint", Label).update("Copied to clipboard!")

    def _paste_slug(self):
        try:
            text = pyperclip.paste().strip()
        except pyperclip.PyperclipException:
            return
        if not text:
            return
        self.query_one("#room-input", Input).value = text

    def on_input_submitted(self, event: Input.Submitted):
        asyncio.create_task(self._submit_async())

    def _submit(self):
        # Sync wrapper kept so button handlers don't have to be async. The
        # probe must run on the event loop, so we tail-call the async path.
        asyncio.create_task(self._submit_async())

    async def _submit_async(self):
        username = self.query_one("#username-input", Input).value.strip()
        hint = self.query_one("#hint", Label)

        if self._mode == "private_create":
            password = self._private_password
        elif self._mode == "private_paste":
            raw = self.query_one("#room-input", Input).value.strip()
            password = parse_invite(raw) or ""
            if not password:
                hint.update("[red]invalid invite — paste the URL or 22-char code[/red]")
                return
        elif self._mode == "create":
            room_id = self._slug
            password = ""
        else:
            room_id = self.query_one("#room-input", Input).value.strip()
            password = ""
            # Friendly nudge if the user pasted a private invite into the
            # public-join field — same UX as the web client.
            if not room_id:
                hint.update("[red]enter a room name[/red]")
                return
            if parse_invite(room_id):
                self._mode = "private_paste"
                self._initial_invite = parse_invite(room_id)
                self._apply_mode()
                hint.update("[yellow]that looks like a private invite — switched tabs[/yellow]")
                return

        if not username:
            hint.update("[red]enter your name[/red]")
            return

        # Disable the go button while we probe so impatient double-clicks
        # don't spawn parallel probe tasks (they'd race the disconnect).
        go_btn = self.query_one("#go-btn", Button)
        go_btn.disabled = True
        try:
            if password:
                # Argon2id is ~250 ms — derive once before probing so VauxApp
                # doesn't pay the cost again on its real join.
                try:
                    hint.update("deriving keys…")
                    self.refresh()
                    material = derive_room_material(password)
                except Exception as exc:
                    hint.update(f"[red]derivation failed: {exc}[/red]")
                    return

                hint.update("connecting…")
                self.refresh()
                from vaux.crypto import encrypt_chat
                cipher = encrypt_chat(material.chat_key, username)
                err = await probe_join(
                    self.server_url,
                    material.room_id,
                    cipher,
                    is_private=True,
                    auth_proof_b64=auth_proof_to_b64(material.auth_proof),
                    create=(self._mode == "private_create"),
                )
                if err:
                    hint.update(f"[red]{err}[/red]")
                    return
                self.result = LobbySelection(
                    room_id=material.room_id,
                    username=username,
                    is_private=True,
                    auth_proof_b64=auth_proof_to_b64(material.auth_proof),
                    chat_key=material.chat_key,
                    password=password,
                    create=(self._mode == "private_create"),
                )
            else:
                if not room_id:
                    hint.update("[red]enter a room name[/red]")
                    return
                hint.update("connecting…")
                self.refresh()
                err = await probe_join(
                    self.server_url, room_id, username, is_private=False,
                )
                if err:
                    hint.update(f"[red]{err}[/red]")
                    return
                self.result = LobbySelection(
                    room_id=room_id, username=username, is_private=False,
                )

            self.exit()
        finally:
            if self.result is None:
                go_btn.disabled = False

    def action_info(self) -> None:
        self.push_screen(InfoModal(in_room=False))

    def action_report_bug(self) -> None:
        self.push_screen(BugReportModal(in_room=False))


# ── NowPlaying widget ──────────────────────────────────────────────────────
class NowPlaying(Static):
    """Displays current track info and synced position."""

    state: reactive[PlaybackState] = reactive(PlaybackState, recompose=False)

    def __init__(self, **kwargs):
        super().__init__("", **kwargs)
        self._state = PlaybackState()
        self._volume = 100

    def on_mount(self):
        self.set_interval(1, self._render_state)

    def update_state(self, state: PlaybackState):
        self._state = state
        self._render_state()

    def update_volume(self, volume: int) -> None:
        self._volume = volume
        self._render_state()

    def _volume_indicator(self) -> str:
        if self._volume == 0:
            return "🔇 muted"
        if self._volume < 34:
            return f"🔈 {self._volume}%"
        if self._volume < 67:
            return f"🔉 {self._volume}%"
        return f"🔊 {self._volume}%"

    def _progress_bar(self, pos: float, total: float, width: int = 36) -> str:
        if total <= 0:
            return "░" * width
        ratio = min(max(pos / total, 0.0), 1.0)
        filled = int(width * ratio)
        return "█" * filled + "░" * (width - filled)

    # Right column is 50 cols wide; #now-playing has padding: 1 on each
    # side, leaving 48 usable terminal cells per line. Anything wider wraps
    # and pushes the progress bar past the fixed height.
    _CONTENT_CELLS = 48

    @staticmethod
    def _fit(text: str, max_cells: int) -> str:
        """Truncate to terminal cell width, not character count, so wide
        glyphs (CJK, emoji) don't blow past the column."""
        if max_cells <= 0:
            return ""
        if _cell_len(text) <= max_cells:
            return text
        if max_cells == 1:
            return "…"
        return _truncate_cells(text, max_cells - 1) + "…"

    def _render_state(self):
        s = self._state
        vol = self._volume_indicator()
        if not s.video_id:
            self.update(
                Text(f"◼  no track playing\n    {vol}", no_wrap=True, overflow="ellipsis")
            )
            return
        icon = "⏸" if s.is_playing else "▶"
        pos = s.formatted_position()
        total = s.formatted_duration() if s.duration > 0 else "—"

        # Line 1: "{icon}  {title}"  → 2 (icon) + 2 (spaces) = 4 cells prefix.
        title_budget = self._CONTENT_CELLS - 4
        title = self._fit(s.title or "", title_budget)

        # Line 2: "    {channel}  [{pos} / {total}]  {vol}"
        # Time + volume are short and predictable; whatever's left after them
        # (and the 4-space indent + 2-space separators) is the channel budget.
        time_str = f"[{pos} / {total}]"
        suffix_cells = 2 + _cell_len(time_str) + 2 + _cell_len(vol)
        channel_budget = self._CONTENT_CELLS - 4 - suffix_cells
        channel = self._fit(s.channel or "", channel_budget)

        bar = self._progress_bar(s.synced_position(), s.duration)
        self.update(
            Text(
                f"{icon}  {title}\n"
                f"    {channel}  {time_str}  {vol}\n"
                f"    {bar}",
                no_wrap=True,
                overflow="ellipsis",
            )
        )


# ── QueueItem widget ───────────────────────────────────────────────────────
class QueueItem(ListItem):
    """Single queue row; host rows show a red x hint separated from the edge."""

    DEFAULT_CSS = """
    QueueItem {
        layout: horizontal;
        height: 1;
        padding: 0 1;
        align: left middle;
    }

    QueueItem > .queue-item-label {
        width: 1fr;
        content-align: left middle;
    }

    QueueItem > .queue-remove-hint {
        width: 3;
        min-width: 3;
        margin-left: 1;
        margin-right: 2;
        content-align: center middle;
        color: #C44545;
        text-style: bold;
    }
    """

    def __init__(self, item: dict, is_host: bool):
        super().__init__()
        self._item = item
        self._is_host = is_host

    def compose(self) -> ComposeResult:
        title = (self._item.get("title") or "")[:26]
        votes = self._item.get("votes", 0)
        added_by = self._item.get("addedBy", "")
        vote_str = f"+{votes}" if votes >= 0 else str(votes)
        yield Label(f"{vote_str}  {title}  — {added_by}", classes="queue-item-label")
        if self._is_host:
            yield Static("x", classes="queue-remove-hint")


# ── SearchResultItem widget ────────────────────────────────────────────────
class SearchResultItem(ListItem):
    def __init__(self, result: SearchResult):
        super().__init__()
        self.result = result

    def compose(self) -> ComposeResult:
        result = self.result
        title = result.title[:50] if result else ""
        channel = result.channel if result else ""
        yield Label(f"  {title}  [{channel}]")


# ── VauxApp ────────────────────────────────────────────────────────────────
class VauxApp(App):

    CSS = """
    Screen {
        layout: vertical;
    }

    #main {
        layout: horizontal;
        height: 1fr;
    }

    #left {
        width: 1fr;
        layout: vertical;
        border-right: solid $primary-darken-2;
    }

    #right {
        width: 50;
        layout: vertical;
    }

    #queue-list {
        height: 1fr;
        border-bottom: solid $primary-darken-2;
    }

    #search-results {
        height: 12;
        border-bottom: solid $primary-darken-2;
    }

    #search-bar {
        layout: horizontal;
        height: 3;
        padding: 0 1;
    }

    #search-input {
        width: 1fr;
    }

    #now-playing {
        height: 6;
        padding: 1;
        border-bottom: solid $primary-darken-2;
        color: $success;
    }

    /* Compact status feed sits between now-playing and chat. Fixed at 5
       cells so the bulk of the right column belongs to chat — system events
       scroll out of view here while chat history stays long. */
    #system-log {
        height: 5;
        border-bottom: solid $primary-darken-2;
    }

    #chat-log {
        height: 1fr;
    }

    #chat-bar {
        height: 3;
        padding: 0 1;
        layout: horizontal;
    }

    #chat-input {
        width: 1fr;
    }

    NowPlaying {
        padding: 0 1;
    }

    Label {
        padding: 0 1;
    }

    .search-status {
        color: $text-muted;
        text-style: italic;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+g", "info", "Info", show=True),
        Binding("ctrl+l", "show_listeners", "Listeners", show=True),
        Binding("ctrl+s", "focus_search", "Search", show=True),
        Binding("ctrl+t", "focus_chat", "Chat", show=True),
        Binding("ctrl+u", "vote_up", "Vote ▲", show=False),
        Binding("ctrl+d", "vote_down", "Vote ▼", show=False),
        Binding("ctrl+o", "toggle_playback", "Play/Pause", show=True),
        Binding("ctrl+n", "skip_track", "Skip ▶", show=True),
        Binding("ctrl+r", "clear_search", "Clear Results", show=False),
        Binding("ctrl+b", "report_bug", "Bug", show=False),
        Binding("x", "remove_queue_item", "Remove", show=False),
        Binding("delete", "remove_queue_item", "Remove", show=False),
        Binding("-", "volume_down", "Vol -", show=False),
        Binding("=", "volume_up", "Vol +", show=False),
        Binding("m", "toggle_mute", "Mute", show=False),
        Binding("ctrl+k", "copy_room", "Copy room", show=False),
    ]

    # Cap on system-message length before truncating with an ellipsis. Sized to
    # comfortably fit on the 50-cell right column with the `· ` prefix and dim
    # styling, while still letting genuine error strings (e.g. mpv-not-found,
    # stream-resolution failures) keep their actionable second half.
    _SYSTEM_MSG_MAX = 120

    # Tighter cap for *titles inside* system messages (now-playing, skipping,
    # added). 50-cell column - "· " - "▶ " ≈ 46, but with the trailing
    # ellipsis and emoji width variance, 28 keeps single-line on most terminals.
    _LOG_TITLE_MAX = 28

    # Strip trailing YouTube boilerplate ("(Official Music Video)", "[HD]",
    # "(Full Album)" etc.) before truncating titles for the chat log. Without
    # this, the [:28] cap often keeps the boilerplate ("Trim - Coconut Water
    # (Official Music Vid") and discards the actual song name. Applied
    # iteratively because uploads commonly stack multiple suffixes such as
    # "Song (Official Audio) [HD]". Matches at end-of-string only — leading
    # tags like "[NEW]" are too varied to enumerate safely.
    _NOISE_SUFFIX_RE = re.compile(
        r"\s*[\(\[]\s*"
        r"(?:full\s+album|album\s+version|"
        r"official\s+(?:music\s+)?(?:video|audio|mv|visualizer)|"
        r"(?:music|lyric|lyrics?)\s*video|"
        r"official|audio|hd|4k|hq|visualizer|lyrics?)"
        r"\s*[\)\]]\s*$",
        re.IGNORECASE,
    )

    @classmethod
    def _clean_title(cls, title: str) -> str:
        """Strip trailing YouTube boilerplate so chat-log titles fit on a
        single line after the [:_LOG_TITLE_MAX] cap. Loops until stable so
        stacked suffixes both go (e.g. `Song (Audio) [HD]` → `Song`)."""
        out = (title or "").strip()
        prev = None
        while prev != out:
            prev = out
            out = cls._NOISE_SUFFIX_RE.sub("", out).rstrip()
        return out or "track"

    def __init__(
        self,
        room_id: str,
        username: str,
        server_url: str,
        *,
        is_private: bool = False,
        auth_proof_b64: str = "",
        chat_key: bytes = b"",
        password: str = "",
        create_private: bool = False,
    ):
        super().__init__()
        self.room_id = room_id
        self.username = username
        self.server_url = server_url

        # Private-room state. chat_key + auth_proof are derived once in the
        # lobby (Argon2id is ~250 ms — never re-derive at runtime). password
        # is kept ONLY so users can copy the invite URL from in-room.
        self.is_private = bool(is_private)
        self._auth_proof_b64 = auth_proof_b64
        self._chat_key = chat_key
        self._password = password
        self._create_private = create_private and is_private
        # userId → decrypted display name. Server never sees these for private
        # rooms; we maintain the mapping locally per session.
        self._name_cache: dict[str, str] = {}

        self.socket = VauxSocket(server_url)
        # Real identity is the server-assigned UUID we get back in room:joined.
        # All host / "is this me" checks compare against this, not username.
        self.user_id = ""
        self.is_host = False
        self.role = "listener"
        self.members: list[dict] = []
        self.queue: list[dict] = []
        # Set by _on_room_join_failed before we exit() so main.py can decide
        # whether to re-open the lobby with the error displayed.
        self.join_error: str | None = None
        self._joined = False
        self.playback = PlaybackState()
        self.search_results: list[SearchResult] = []
        self.last_video_id = None
        self.player_running = False
        # Tracks the updatedAt of the last server playback state we acted on.
        # Lets _apply_playback distinguish a fresh broadcast (host scrubbed,
        # paused, etc.) from a redundant re-apply after, e.g., a member-join
        # event so we don't issue spurious mpv seeks.
        self._last_applied_updated_at: float = 0.0
        self.stream_cache: dict[str, str] = {}
        self.volume = 100
        self._volume_before_mute = 100
        self._chat_history: list[str] = []
        self._chat_history_idx: int = -1

        self._search_loading = False
        self._search_dots_timer = None
        self._search_dot_count = 1
        self._search_status_label: Label | None = None

        mpv_path = find_mpv()
        self.player = MPVPlayer(mpv_path) if mpv_path else None

    # ── layout ─────────────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True, icon="☰")

        with Horizontal(id="main"):
            # left: queue + search
            with Vertical(id="left"):
                yield Label("  queue", id="queue-label")
                yield ListView(id="queue-list")
                yield Label("  results", id="results-label")
                yield ListView(id="search-results")
                with Horizontal(id="search-bar"):
                    yield Input(placeholder="search youtube...", id="search-input")
                    yield Button("Search", id="search-btn", variant="primary")

            # right: now playing + system + chat
            with Vertical(id="right"):
                yield NowPlaying(id="now-playing")
                # Dedicated status log for self-posts (loading, skipping,
                # joins/leaves, paused/resumed). Lives above chat so chat
                # stays uninterrupted by system noise. RichLog auto-scrolls
                # by default, so newer events always end up visible.
                yield RichLog(
                    id="system-log",
                    highlight=False,
                    markup=False,
                    wrap=True,
                    min_width=20,
                    # Smaller cap than chat — system messages are noise that
                    # ages out fast; nobody scrolls back through them.
                    max_lines=50,
                    auto_scroll=True,
                )
                yield RichLog(
                    id="chat-log",
                    highlight=True,
                    markup=True,
                    wrap=True,
                    min_width=20,
                    # Cap retained backlog so a long-lived room doesn't grow
                    # the in-memory log unboundedly. ~200 lines is multiple
                    # hours of typical chat + system events.
                    max_lines=200,
                )
                with Horizontal(id="chat-bar"):
                    yield Input(placeholder="say something...", id="chat-input")
                    yield Button("→", id="chat-btn", variant="success")

        yield Footer()

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def on_mount(self):
        # Private rooms hide the random roomId from the header — it's an
        # opaque base64url string with no value to the user, and showing it
        # could leak shoulder-surfing bits. The 🔒 makes the mode obvious.
        self.title = "vaux / 🔒 private" if self.is_private else f"vaux / {self.room_id}"
        self.sub_title = "connecting…"
        self.screen.loading = True
        self._register_socket_events()
        await self.socket.connect()

        if self.is_private:
            # Encrypt the username with chatKey before sending — the server
            # never sees plaintext names for private rooms. Cipher object
            # `{ct, nonce}` is opaquely relayed by the server.
            cipher = encrypt_chat(self._chat_key, self.username)
            await self.socket.join_room(
                self.room_id,
                cipher,
                auth_proof_b64=self._auth_proof_b64,
                create=self._create_private,
            )
        else:
            await self.socket.join_room(self.room_id, self.username)

        self.set_interval(1.0, self._check_player_status)

    async def on_unmount(self):
        if getattr(self, "player", None):
            self.player.stop()
        # Host leaving a private room burns it — server immediately deletes
        # state and force-disconnects remaining sockets. Listeners see
        # "could not join — room no longer exists" if they try to rejoin.
        if self.is_private and self.is_host:
            try:
                await self.socket.destroy_room(self.room_id)
            except Exception:
                pass
        await self.socket.disconnect()

    # ── socket event wiring ────────────────────────────────────────────────
    def _register_socket_events(self):
        self.socket.on("room:joined", self._on_room_joined)
        self.socket.on("room:member_joined", self._on_member_joined)
        self.socket.on("room:member_left", self._on_member_left)
        self.socket.on("host:changed", self._on_host_changed)
        self.socket.on("queue:updated", self._on_queue_updated)
        self.socket.on("playback:state", self._on_playback_state)
        self.socket.on("chat:message", self._on_chat_message)
        self.socket.on("chat:rate_limited", self._on_chat_rate_limited)
        self.socket.on("queue:full", self._on_queue_full)
        self.socket.on("room:join_failed", self._on_room_join_failed)
        self.socket.on("reaction:broadcast", self._on_reaction)

    def _decrypt_name(self, cipher: dict | None) -> str | None:
        """Decrypt a usernameCipher object. Returns None if absent or
        tampered — caller falls back to a generic placeholder."""
        if not isinstance(cipher, dict) or not self._chat_key:
            return None
        ct = cipher.get("ct")
        nonce = cipher.get("nonce")
        if not isinstance(ct, str) or not isinstance(nonce, str):
            return None
        return decrypt_chat(self._chat_key, ct, nonce)

    def _resolve_member_name(self, member: dict) -> str:
        """Pick a display name for a member. Public rooms ship plaintext
        usernames; private rooms ship usernameCipher and we decrypt locally
        with chatKey, caching by userId so we don't re-decrypt per chat msg."""
        uid = member.get("userId", "")
        if not self.is_private:
            return member.get("username") or uid or "?"
        if uid and uid in self._name_cache:
            return self._name_cache[uid]
        decrypted = self._decrypt_name(member.get("usernameCipher"))
        name = decrypted or "anon"
        if uid:
            self._name_cache[uid] = name
        return name

    async def _on_room_joined(self, data: dict):
        try:
            self._joined = True
            self.user_id = data.get("userId", "")
            self.role = data.get("role", "listener")
            self.is_host = self.role == "host"
            members = data.get("members", []) or []
            # Normalize private members so the rest of the app can read
            # `member["username"]` regardless of room type. Skip the cipher
            # field afterward — it never leaves this method.
            for m in members:
                if self.is_private:
                    m["username"] = self._resolve_member_name(m)
                    m.pop("usernameCipher", None)
            self.members = members
            initial_queue = data.get("queue", []) or []
            for track in initial_queue:
                track["addedBy"] = self._resolve_added_by(track)
            self.queue = initial_queue
            pb = data.get("playbackState") or {}
            self.playback = PlaybackState.from_dict(pb)
            await self._refresh_queue()
            self._refresh_now_playing()
            self.query_one("#now-playing", NowPlaying).update_volume(self.volume)
            self._update_header_subtitle()
            # `joined` first so the user sees their join confirmation before
            # the syncing notice that _apply_playback may emit.
            suffix = " · 🔒 chat E2E" if self.is_private else ""
            self._post_system(f"joined [{self.role}]{suffix}")
            if self.is_private:
                # System log is ~18 cells wide and RichLog auto-wraps a long
                # disclaimer into 3-4 ragged lines. Use a transient toast so
                # the warning is seen once without eating permanent space.
                self.notify(
                    "chat is end-to-end encrypted — queue & playback are not",
                    timeout=8,
                )
            await self._apply_playback(announce=False)
            if not getattr(self, "player", None):
                self._post_system("mpv not found on system. Please install mpv to hear audio.")
        finally:
            self.screen.loading = False

    async def _on_member_joined(self, data: dict):
        user_id = data.get("userId")
        if not user_id or any(m.get("userId") == user_id for m in self.members):
            return
        if self.is_private:
            uname = self._decrypt_name(data.get("usernameCipher")) or "anon"
            self._name_cache[user_id] = uname
        else:
            uname = data.get("username", "?")
        self.members.append(
            {"userId": user_id, "username": uname, "role": "listener"},
        )
        self._post_system(f"{uname} joined")

    async def _on_member_left(self, data: dict):
        uid = data.get("userId", "?")
        left = next((m for m in self.members if m.get("userId") == uid), None)
        self.members = [m for m in self.members if m.get("userId") != uid]
        name = left.get("username", uid) if left else uid
        self._name_cache.pop(uid, None)
        self._post_system(f"{name} left")
        self._update_header_subtitle()

    async def _on_host_changed(self, data: dict):
        new_host_id = data.get("newHostId")
        self.is_host = bool(self.user_id) and new_host_id == self.user_id
        self.role = "host" if self.is_host else "listener"
        for member in self.members:
            member["role"] = "host" if member.get("userId") == new_host_id else "listener"

        if self.is_private:
            # Server omits plaintext newHostUsername for private rooms.
            decrypted = self._decrypt_name(data.get("newHostUsernameCipher"))
            if decrypted and new_host_id:
                self._name_cache[new_host_id] = decrypted
            new_name = (
                decrypted
                or self._name_cache.get(new_host_id or "")
                or "anon"
            )
        else:
            new_name = data.get("newHostUsername", new_host_id)
        self.notify(f"⭐ {new_name} is now host", timeout=3)
        self._update_header_subtitle()
        await self._refresh_queue()

    def _resolve_added_by(self, track: dict) -> str:
        """Display name for a queue item's adder. Public rooms get the
        plaintext `addedBy` server-side; private rooms get only `addedById`
        and we look up the locally-decrypted name."""
        if track.get("addedBy"):
            return track["addedBy"]
        uid = track.get("addedById")
        if uid:
            cached = self._name_cache.get(uid)
            if cached:
                return cached
            member = next((m for m in self.members if m.get("userId") == uid), None)
            if member and member.get("username"):
                return member["username"]
        return "anon"

    async def _on_queue_updated(self, data: dict):
        old_ids = {t["id"] for t in self.queue}
        incoming = data.get("queue", []) or []
        # Normalize addedBy in-place so QueueItem rendering and toast text
        # don't both need to re-resolve. Private rooms ship addedBy=undefined.
        for track in incoming:
            track["addedBy"] = self._resolve_added_by(track)
        self.queue = incoming
        for track in self.queue:
            if track["id"] in old_ids:
                continue
            # Prefer userId match (accurate even when usernames collide);
            # fall back to username for older servers.
            added_by_id = track.get("addedById")
            if added_by_id and added_by_id == self.user_id:
                continue
            if not added_by_id and track.get("addedBy") == self.username:
                continue
            title = (track.get("title") or "")[:40]
            added_by = track.get("addedBy") or "?"
            self.notify(f"♪ {title} added by {added_by}", timeout=3)
        await self._refresh_queue()

    async def _on_playback_state(self, data: dict):
        # Capture the previous track id BEFORE we overwrite playback so we
        # can fire a transient toast on actual track changes (vs play/pause/
        # seek, which keep the same videoId). Initial state lands in
        # _on_room_joined, not here, so listeners won't get a redundant
        # toast at room-entry time.
        old_video_id = self.playback.video_id
        self.playback = PlaybackState.from_dict(data)

        if self.playback.video_id and self.playback.video_id != old_video_id:
            title = self._clean_title(self.playback.title or "track")[: self._LOG_TITLE_MAX]
            self.notify(f"♪ {title}", timeout=4)

        self._refresh_now_playing()
        await self._apply_playback()

    async def _on_chat_message(self, data: dict):
        uid = data.get("userId", "")
        if self.is_private:
            ct = data.get("ct")
            nonce = data.get("nonce")
            if not isinstance(ct, str) or not isinstance(nonce, str):
                return
            text = decrypt_chat(self._chat_key, ct, nonce)
            if text is None:
                # Tampered or wrong-key message — drop silently. Never bubble
                # the failure to the user (could leak adversarial probing).
                return
            uname = self._name_cache.get(uid) or self._resolve_member_name(
                next((m for m in self.members if m.get("userId") == uid), {"userId": uid}),
            )
        else:
            uname = data.get("username", "?")
            text = data.get("text", "")
        self._post_chat(uname, text, uid)

    async def _on_chat_rate_limited(self, data: dict):
        self._post_system("slow down — too many messages")

    async def _on_queue_full(self, data: dict):
        cap = data.get("max", "?")
        self.notify(f"queue is full (max {cap} tracks)", severity="warning", timeout=4)

    async def _on_room_join_failed(self, data: dict):
        reason = data.get("reason", "join refused")

        if self.is_private:
            # Private rooms collapse "wrong password" and "room not found"
            # into one message so adversaries can't probe for room existence.
            if reason == "auth_failed":
                msg = "wrong password, or this room no longer exists"
            elif reason == "locked":
                ms = data.get("retryAfterMs", 60_000)
                msg = f"too many attempts — try again in {max(1, ms // 1000)}s"
            elif reason in ("room full", "capacity"):
                msg = "private room is full"
            else:
                msg = reason
        else:
            msg = reason

        # If we never made it past room:joined, bail back to the lobby with
        # the error pre-rendered. Otherwise (we WERE in the room and the
        # server kicked us mid-session) keep the UI alive and just toast —
        # rare path, but trapping the user in the lobby would be jarring.
        if not self._joined:
            self.join_error = msg
            self.exit()
            return

        self.notify(f"could not join: {msg}", severity="error", timeout=8)
        self._post_system(f"could not join: {msg}")

    async def _on_reaction(self, data: dict):
        emoji = data.get("emoji", "")
        self._post_system(emoji)

    # ── UI refresh helpers ─────────────────────────────────────────────────
    async def _refresh_queue(self):
        lv = self.query_one("#queue-list", ListView)
        await lv.clear()
        for item in self.queue:
            await lv.append(QueueItem(item, self.is_host))

    def _refresh_now_playing(self):
        widget = self.query_one("#now-playing", NowPlaying)
        widget.update_state(self.playback)

    def _update_header_subtitle(self) -> None:
        host = next((m for m in self.members if m.get("role") == "host"), None)
        name = (host.get("username") if host else None) or "?"
        self.sub_title = f"host: {name[:30]}"

    def _post_chat(self, username: str, text: str, user_id: str = ""):
        log = self.query_one("#chat-log", RichLog)
        t = Text()
        color = color_for_user(user_id) if user_id else "#52d4a0"
        t.append(f"{username[:20]} ", style=f"bold {color}")
        t.append(text)
        log.write(t)

    def _post_system(self, text: str):
        log = self.query_one("#system-log", RichLog)
        # Truncate over-long messages so a single system event can't wrap to
        # multiple lines and consume too much of the small log area.
        if len(text) > self._SYSTEM_MSG_MAX:
            text = text[: self._SYSTEM_MSG_MAX - 1] + "…"
        log.write(Text(text, style="dim"))

    def _check_player_status(self):
        """Polls the mpv process to auto-skip when a track ends naturally or crashes."""
        if not self.is_host or not self.playback.is_playing:
            return
        if self.player and self.player.proc and self.player.proc.poll() is not None:
            self.player.proc = None
            self.player_running = False
            asyncio.create_task(self._trigger_ended())

    async def _apply_playback(self, *, announce: bool = True):
        """Syncs the python-mpv player instance with the server playback state.

        `announce=False` is used on the initial-join path to suppress the
        per-event `⏳ loading stream…` and `▶ {title}` chat lines, which
        would otherwise look like the user just triggered playback. A single
        `♪ music playing, syncing…` notice is emitted instead so the listener
        knows audio is buffering. Errors are NOT gated by announce — if the
        stream fails on join, the listener still needs to see why audio
        never starts.
        """
        if not getattr(self, "player", None):
            return

        s = self.playback
        if not s.video_id:
            self.player.stop()
            self.last_video_id = None
            self.player_running = False
            self._last_applied_updated_at = s.updated_at
            return

        needs_play = s.is_playing and (s.video_id != self.last_video_id or not self.player_running)
        # Seek-while-playing: same track, mpv already running, but the host
        # scrubbed (or otherwise re-anchored) the timeline. Without this branch
        # mpv keeps playing from its old position until the next pause/play
        # toggle, which is the bug "scrubbing on web doesn't sync with cli".
        # We require a new updatedAt so initial-join / member-join re-applies
        # don't trigger gratuitous seeks.
        is_seek = (
            s.is_playing
            and not needs_play
            and s.video_id == self.last_video_id
            and self.player_running
            and s.updated_at != self._last_applied_updated_at
        )

        if needs_play:
            # Captured before we mutate last_video_id below so we can
            # distinguish "first play of a new track" from "resume after pause"
            # Only the former should announce "▶ now playing" — a
            # resume isn't a new track from the user's perspective.
            is_new_track = s.video_id != self.last_video_id
            track_label = self._clean_title(s.title or "track")[: self._LOG_TITLE_MAX]

            if not announce:
                # Single concise notice on initial join, emitted before stream
                self._post_system("♪ syncing…")

            stream_url = self.stream_cache.get(s.video_id)
            stream_error: str | None = None
            if not stream_url:
                # Stream resolution is the 5–10s gap that previously made the
                # CLI feel unresponsive after a play/skip.
                if announce:
                    self._post_system("⏳ loading stream…")
                stream_url, stream_error = await get_stream_url(
                    self.server_url, s.video_id
                )
                if stream_url:
                    self.stream_cache[s.video_id] = stream_url

            if stream_url:
                target_pos = s.synced_position()
                self.player.play(stream_url, start=target_pos, volume=self.volume)
                self.last_video_id = s.video_id
                self.player_running = True
                if is_new_track and announce:
                    # `▶` icon already conveys "playing" — drop the verbose
                    # "now playing:" label so the title fits on one line.
                    self._post_system(f"▶ {track_label}")
            else:
                detail = f" {stream_error}" if stream_error else ""
                self._post_system(f"failed to load stream.{detail}")
                if self.is_host:
                    await self._trigger_ended()

        elif not s.is_playing and self.player_running:
            self.player.stop()
            self.player_running = False

        elif is_seek:
            self.player.seek(s.synced_position())

        self._last_applied_updated_at = s.updated_at

    async def _trigger_ended(self):
        """Tells the server the track finished so it can auto-play the next queue item."""
        if self.is_host:
            await self.socket.ended(self.room_id)

    # ── button handlers ────────────────────────────────────────────────────
    async def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id or ""
        if btn_id == "search-btn":
            await self._do_search()
        elif btn_id == "chat-btn":
            await self._do_send_chat()

    async def on_input_submitted(self, event: Input.Submitted):
        if event.input.id == "search-input":
            await self._do_search()
        elif event.input.id == "chat-input":
            await self._do_send_chat()

    async def _do_search(self):
        inp = self.query_one("#search-input", Input)
        query = inp.value.strip()
        if not query:
            return

        await self._set_search_loading(True)
        try:
            results = await search_youtube(self.server_url, query)
        except Exception as exc:
            await self._set_search_loading(False)
            lv = self.query_one("#search-results", ListView)
            await lv.clear()
            self.search_results = []
            await lv.append(
                ListItem(
                    Label("  search failed", classes="search-status"),
                    disabled=True,
                )
            )
            self._post_system(f"Search failed: {exc}")
            return

        await self._set_search_loading(False)

        self.search_results = results
        lv = self.query_one("#search-results", ListView)
        await lv.clear()
        if not results:
            await lv.append(
                ListItem(
                    Label("  no results found", classes="search-status"),
                    disabled=True,
                )
            )
        else:
            for r in results:
                await lv.append(SearchResultItem(r))
        self.query_one("#results-label", Label).update(f"  results · {len(results)}")
        inp.value = ""

    async def _set_search_loading(self, loading: bool) -> None:
        """Toggles the searching-in-progress placeholder + disables inputs."""
        inp = self.query_one("#search-input", Input)
        btn = self.query_one("#search-btn", Button)
        lv = self.query_one("#search-results", ListView)

        if loading:
            if self._search_loading:
                return
            self._search_loading = True
            inp.disabled = True
            btn.disabled = True
            btn.label = "..."

            self.query_one("#results-label", Label).update("  results")
            await lv.clear()
            self.search_results = []
            self._search_dot_count = 1
            status = Label("searching.", classes="search-status")
            self._search_status_label = status
            await lv.append(ListItem(status, disabled=True))
            self._search_dots_timer = self.set_interval(0.4, self._tick_search_dots)
        else:
            if not self._search_loading:
                return
            self._search_loading = False
            if self._search_dots_timer is not None:
                self._search_dots_timer.stop()
                self._search_dots_timer = None
            self._search_status_label = None
            inp.disabled = False
            btn.disabled = False
            btn.label = "Search"

    def _tick_search_dots(self) -> None:
        if self._search_status_label is None:
            return
        self._search_dot_count = (self._search_dot_count % 3) + 1
        self._search_status_label.update("searching" + "." * self._search_dot_count)

    async def _do_send_chat(self):
        inp = self.query_one("#chat-input", Input)
        text = inp.value.strip()
        if not text:
            return

        self._chat_history.insert(0, text)
        self._chat_history = self._chat_history[:50]
        self._chat_history_idx = -1

        if text.startswith("/host "):
            if not self.is_host:
                self._post_system("Only the host can transfer privileges.")
            else:
                target = text[6:].strip()
                # First listener whose display name matches wins. With server-
                # assigned userIds, two users can share a name — if that
                # happens, the earlier joiner is promoted.
                match = next(
                    (m for m in self.members
                     if m.get("username") == target and m.get("role") != "host"),
                    None,
                )
                if not match:
                    self._post_system(f"no listener named '{target}'")
                else:
                    await self.socket.transfer_host(self.room_id, match["userId"])
            inp.value = ""
            return

        if len(text) > 300:
            self._post_system("message too long (max 300 chars)")
            return

        if self.is_private:
            cipher = encrypt_chat(self._chat_key, text)
            await self.socket.send_chat(
                self.room_id, ct=cipher["ct"], nonce=cipher["nonce"],
            )
        else:
            await self.socket.send_chat(self.room_id, text)
        inp.value = ""

    # ── list selection — queue and search results ──────────────────────────
    async def on_list_view_selected(self, event: ListView.Selected):
        lv_id = event.list_view.id

        if lv_id == "search-results":
            idx = event.list_view.index
            if idx is not None and idx < len(self.search_results):
                r = self.search_results[idx]
                await self.socket.add_to_queue(
                    self.room_id,
                    r.video_id,
                    r.title,
                    r.channel,
                    r.thumbnail,
                    r.duration,
                )
                self._post_system(f"added: {self._clean_title(r.title)[: self._LOG_TITLE_MAX]}")
                lv = self.query_one("#search-results", ListView)
                await lv.clear()
                self.search_results = []
                self.query_one("#results-label", Label).update("  results")

        elif lv_id == "queue-list" and self.is_host:
            idx = event.list_view.index
            if idx is not None and idx < len(self.queue):
                item = self.queue[idx]
                await self.socket.play_track(self.room_id, item["id"])

    # ── keybinding actions ─────────────────────────────────────────────────
    def action_focus_search(self):
        self.query_one("#search-input", Input).focus()

    def action_focus_chat(self):
        self.query_one("#chat-input", Input).focus()

    async def action_clear_search(self):
        if not self.search_results:
            return
        lv = self.query_one("#search-results", ListView)
        await lv.clear()
        self.search_results = []
        self.query_one("#results-label", Label).update("  results")

    async def action_vote_up(self):
        lv = self.query_one("#queue-list", ListView)
        idx = lv.index
        if idx is not None and idx < len(self.queue):
            await self.socket.vote(self.room_id, self.queue[idx]["id"], 1)

    async def action_vote_down(self):
        lv = self.query_one("#queue-list", ListView)
        idx = lv.index
        if idx is not None and idx < len(self.queue):
            item = self.queue[idx]
            if item.get("votes", 0) >= 1:
                await self.socket.vote(self.room_id, item["id"], -1)

    async def action_toggle_playback(self):
        if not self.is_host or not self.playback.video_id:
            return
            
        current_pos = self.playback.synced_position()
        if self.playback.is_playing:
            await self.socket.pause(self.room_id, current_pos)
            self._post_system("paused playback")
        else:
            await self.socket.play(self.room_id, current_pos)
            self._post_system("resumed playback")

    async def action_skip_track(self):
        if not self.is_host:
            self._post_system("only the host can skip tracks.")
            return
        if self.playback.video_id:
            # Chat-log entry leaves a permanent record of the skip; the
            # transient toast separately tells the user the audio gap is
            # expected (stream resolution for the next track takes ~5s).
            title = self._clean_title(self.playback.title or "track")[: self._LOG_TITLE_MAX]
            self._post_system(f"⏭  skipping: {title}")
            self.notify(
                "skipped · next track loading, audio starts in ~5s…",
                timeout=4,
            )
            await self._trigger_ended()

    def _focused_in_queue(self) -> bool:
        lv = self.query_one("#queue-list", ListView)
        widget = self.focused
        while widget is not None:
            if widget is lv:
                return True
            widget = widget.parent
        return False

    async def action_remove_queue_item(self):
        if not self.is_host:
            self._post_system("Only the host can remove tracks.")
            return
        if not self._focused_in_queue():
            return
        lv = self.query_one("#queue-list", ListView)
        idx = lv.index
        if idx is not None and idx < len(self.queue):
            item = self.queue[idx]
            await self.socket.remove_from_queue(self.room_id, item["id"])
            self._post_system(f"removed: {item.get('title', '')[:40]}")

    def action_volume_down(self):
        self.volume = max(0, self.volume - 10)
        if getattr(self, "player", None):
            self.player.set_volume(self.volume)
        self.query_one("#now-playing", NowPlaying).update_volume(self.volume)

    def action_volume_up(self):
        self.volume = min(100, self.volume + 10)
        if getattr(self, "player", None):
            self.player.set_volume(self.volume)
        self.query_one("#now-playing", NowPlaying).update_volume(self.volume)

    def action_toggle_mute(self):
        if self.volume == 0:
            self.volume = self._volume_before_mute or 100
        else:
            self._volume_before_mute = self.volume
            self.volume = 0
        if getattr(self, "player", None):
            self.player.set_volume(self.volume)
        self.query_one("#now-playing", NowPlaying).update_volume(self.volume)

    def action_copy_room(self):
        if self.is_private:
            if not self._password:
                # CLI knows the API origin (server_url), not the web origin —
                # can't synthesize a clickable URL. We copy the bare password
                # which parse_invite() accepts on both web and CLI.
                self.notify(
                    "Invite code unavailable in this session",
                    severity="warning",
                    timeout=4,
                )
                return
            try:
                pyperclip.copy(self._password)
                self.notify("Private code copied", timeout=2)
            except pyperclip.PyperclipException:
                self.notify("Clipboard unavailable", severity="error", timeout=3)
            return

        try:
            pyperclip.copy(self.room_id)
            self.notify("Room name copied!", timeout=2)
        except pyperclip.PyperclipException:
            self.notify("Clipboard unavailable", severity="error", timeout=3)

    def on_key(self, event) -> None:
        if self.focused is None or self.focused.id != "chat-input":
            return
        inp = self.query_one("#chat-input", Input)
        if event.key == "up" and self._chat_history:
            self._chat_history_idx = min(
                self._chat_history_idx + 1, len(self._chat_history) - 1
            )
            inp.value = self._chat_history[self._chat_history_idx]
            event.stop()
        elif event.key == "down":
            self._chat_history_idx = max(self._chat_history_idx - 1, -1)
            inp.value = (
                self._chat_history[self._chat_history_idx]
                if self._chat_history_idx >= 0
                else ""
            )
            event.stop()

    def action_info(self) -> None:
        self.push_screen(InfoModal(in_room=True))

    def action_report_bug(self) -> None:
        self.push_screen(BugReportModal(in_room=True))

    def action_show_listeners(self) -> None:
        if not self.is_host:
            self._post_system("Only the host can view the listener list.")
            return
        self.push_screen(ListenersModal(self.members, self._transfer_host_from_modal))

    async def _transfer_host_from_modal(self, user_id: str) -> None:
        await self.socket.transfer_host(self.room_id, user_id)