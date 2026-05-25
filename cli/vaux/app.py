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

from vaux.socket_client import VauxSocket
from vaux.playback import PlaybackState
from vaux.api import search_youtube, SearchResult, get_stream_url
from vaux.mpv import find_mpv
from vaux.room_slug import generate_room_slug

import subprocess
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

    def set_volume(self, volume: int):
        command = {"command": ["set_property", "volume", volume]}
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

try:
    APP_VERSION = version("vaux-cli")
except PackageNotFoundError:
    APP_VERSION = "dev"

APP_AUTHOR = "Violet Nguyen (Vee)"
APP_WEBSITE = "https://itsvee0120.github.io/violet-website/"
APP_GITHUB = "https://github.com/itsvee0120/vaux"
APP_PYPI = "https://pypi.org/project/vaux-cli/"


def _build_app_info(in_room: bool) -> str:
    lines = [
        "listen together, in sync",
        "",
        f"Version   {APP_VERSION}",
        f"Author    {APP_AUTHOR}",
        "",
        "Links",
        f"  Website  {APP_WEBSITE}",
        f"  GitHub   {APP_GITHUB}",
        f"  PyPI     {APP_PYPI}",
    ]
    if in_room:
        lines.extend([
            "",
            "Shortcuts",
            "  ctrl+s   search",
            "  ctrl+t   chat",
            "  ctrl+o   play / pause  (host)",
            "  ctrl+n   skip track    (host)",
            "  delete/x remove queue track (host, queue focused)",
            "  ctrl+u   vote up",
            "  ctrl+d   vote down",
            "  - / =    volume down / up",
            "  ctrl+g   this screen, hit esc to close",
            "  ctrl+l   view listeners & transfer host (host)",
            "  ctrl+c   quit",
            "  type /host <username> to transfer host to another user",
        ])
    else:
        lines.extend([
            "",
            "Shortcuts",
            "  tab      next field",
            "  ctrl+g   this screen, hit esc to close",
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
        height: auto;
        max-height: 90%;
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
        with Vertical(id="info-dialog"):
            yield Label("VAUX", id="info-title")
            yield Static(_build_app_info(self.in_room), id="info-text")
            yield Button("Close", id="info-close", variant="primary")

    def action_dismiss(self) -> None:
        self.dismiss()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "info-close":
            self.dismiss()


class ListenersModal(ModalScreen[None]):
    """Host-only view of everyone in the room."""

    DEFAULT_CSS = """
    ListenersModal {
        align: center middle;
    }

    #listeners-dialog {
        width: 48;
        height: auto;
        max-height: 80%;
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

    theme = "dracula"

    CSS = """
    Screen {
        align: center middle;
    }

    #card {
        width: 52;
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

    #create-btn, #join-btn {
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
        text-align: center;
        color: $text-muted;
        margin-top: 1;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+g", "info", "Info", show=True),
        Binding("tab", "focus_next", "Next field", show=False),
    ]

    def __init__(self, server_url: str):
        super().__init__()
        self.server_url = server_url
        self._mode = "create"
        self._slug = generate_room_slug()
        # result is set before exit so the caller can read it
        self.result: tuple[str, str] | None = None

    def compose(self) -> ComposeResult:
        with Vertical(id="card"):
            yield Label(LOBBY_TITLE, id="title")

            with Horizontal(id="mode-row"):
                yield Button("create room", id="create-btn", variant="success")
                yield Button("join room",   id="join-btn",   variant="default")

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

        yield Footer()

    def on_mount(self):
        self._apply_mode()

    def _apply_mode(self):
        slug_row   = self.query_one("#slug-row")
        room_input_row = self.query_one("#room-input-row")
        room_input = self.query_one("#room-input", Input)
        go_btn     = self.query_one("#go-btn", Button)
        hint       = self.query_one("#hint", Label)
        create_btn = self.query_one("#create-btn", Button)
        join_btn   = self.query_one("#join-btn", Button)
        copy_btn   = self.query_one("#copy-btn", Button)
        paste_btn  = self.query_one("#paste-btn", Button)

        if self._mode == "create":
            slug_row.display   = True
            room_input_row.display = False
            copy_btn.display   = True
            paste_btn.display  = False
            go_btn.label       = "create & join →"
            hint.update("Copy the room name to share with others 📋")
            create_btn.variant = "success"
            join_btn.variant   = "default"
        else:
            slug_row.display   = False
            room_input_row.display = True
            copy_btn.display   = False
            paste_btn.display  = True
            go_btn.label       = "join room →"
            hint.update("Ask the host for their room name")
            create_btn.variant = "default"
            join_btn.variant   = "success"
            room_input.focus()

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id

        if btn_id == "create-btn":
            self._mode = "create"
            self._apply_mode()

        elif btn_id == "join-btn":
            self._mode = "join"
            self._apply_mode()

        elif btn_id == "reroll-btn":
            self._slug = generate_room_slug()
            self.query_one("#slug-display", Label).update(self._slug)

        elif btn_id == "go-btn":
            self._submit()

        elif btn_id == "copy-btn":
            self._copy_slug()

        elif btn_id == "paste-btn":
            self._paste_slug()

    def _copy_slug(self):
        pyperclip.copy(self._slug)
        self.query_one("#hint", Label).update("Copied to clipboard!")

    def _paste_slug(self):
        try:
            text = pyperclip.paste().strip()
        except pyperclip.PyperclipException:
            return
        if text:
            self.query_one("#room-input", Input).value = text

    def on_input_submitted(self, event: Input.Submitted):
        self._submit()

    def _submit(self):
        username = self.query_one("#username-input", Input).value.strip()

        if self._mode == "create":
            room_id = self._slug
        else:
            room_id = self.query_one("#room-input", Input).value.strip()

        hint = self.query_one("#hint", Label)

        if not room_id:
            hint.update("[red]enter a room name[/red]")
            return
        if not username:
            hint.update("[red]enter your name[/red]")
            return

        self.result = (room_id, username)
        self.exit()

    def action_info(self) -> None:
        self.push_screen(InfoModal(in_room=False))


# ── NowPlaying widget ──────────────────────────────────────────────────────
class NowPlaying(Static):
    """Displays current track info and synced position."""

    state: reactive[PlaybackState] = reactive(PlaybackState, recompose=False)

    def __init__(self, **kwargs):
        super().__init__("", **kwargs)
        self._state = PlaybackState()

    def on_mount(self):
        self.set_interval(1, self._render_state)

    def update_state(self, state: PlaybackState):
        self._state = state
        self._render_state()

    def _render_state(self):
        s = self._state
        if not s.video_id:
            self.update("◼  no track playing")
            return
        icon = "⏸" if s.is_playing else "▶"
        pos = s.formatted_position()
        title = (s.title or "")[:50]
        channel = s.channel or ""
        self.update(f"{icon}  {title}\n    {channel}  [{pos}]")


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
    theme = "dracula"

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
        height: 5;
        padding: 1;
        border-bottom: solid $primary-darken-2;
        color: $success;
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
        Binding("x", "remove_queue_item", "Remove", show=True),
        Binding("delete", "remove_queue_item", "Remove", show=False),
        Binding("-", "volume_down", "Vol -", show=True),
        Binding("=", "volume_up", "Vol +", show=True),
    ]

    def __init__(self, room_id: str, username: str, server_url: str):
        super().__init__()
        self.room_id = room_id
        self.username = username
        self.server_url = server_url

        self.socket = VauxSocket(server_url)
        self.is_host = False
        self.role = "listener"
        self.members: list[dict] = []
        self.queue: list[dict] = []
        self.playback = PlaybackState()
        self.search_results: list[SearchResult] = []
        self.last_video_id = None
        self.player_running = False
        self.stream_cache: dict[str, str] = {}
        self.volume = 100

        mpv_path = find_mpv()
        self.player = MPVPlayer(mpv_path) if mpv_path else None

    # ── layout ─────────────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)

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

            # right: now playing + chat
            with Vertical(id="right"):
                yield NowPlaying(id="now-playing")
                yield RichLog(id="chat-log", highlight=True, markup=True)
                with Horizontal(id="chat-bar"):
                    yield Input(placeholder="say something...", id="chat-input")
                    yield Button("→", id="chat-btn", variant="success")

        yield Footer()

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def on_mount(self):
        self.title = f"vaux / {self.room_id}"
        self._register_socket_events()
        await self.socket.connect()
        await self.socket.join_room(self.room_id, self.username, self.username)
        self.set_interval(1.0, self._check_player_status)

    async def on_unmount(self):
        if getattr(self, "player", None):
            self.player.stop()
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
        self.socket.on("reaction:broadcast", self._on_reaction)

    async def _on_room_joined(self, data: dict):
        self.role = data.get("role", "listener")
        self.is_host = self.role == "host"
        self.members = data.get("members", [])
        self.queue = data.get("queue", [])
        pb = data.get("playbackState") or {}
        self.playback = PlaybackState.from_dict(pb)
        await self._refresh_queue()
        self._refresh_now_playing()
        await self._apply_playback()
        self._post_system(f"joined [{self.role}]")
        if not getattr(self, "player", None):
            self._post_system("mpv not found on system. Please install mpv to hear audio.")

    async def _on_member_joined(self, data: dict):
        user_id = data.get("userId")
        uname = data.get("username", "?")
        if user_id and not any(m.get("userId") == user_id for m in self.members):
            self.members.append(
                {"userId": user_id, "username": uname, "role": "listener"},
            )
            self._post_system(f"{uname} joined")

    async def _on_member_left(self, data: dict):
        uid = data.get("userId", "?")
        left = next((m for m in self.members if m.get("userId") == uid), None)
        self.members = [m for m in self.members if m.get("userId") != uid]
        name = left.get("username", uid) if left else uid
        self._post_system(f"{name} left")

    async def _on_host_changed(self, data: dict):
        new_host_id = data.get("newHostId")
        self.is_host = new_host_id == self.username
        self.role = "host" if self.is_host else "listener"
        for member in self.members:
            member["role"] = "host" if member.get("userId") == new_host_id else "listener"
        new_name = data.get("newHostUsername", new_host_id)
        self._post_system(f"⭐ {new_name} is now host")
        await self._refresh_queue()

    async def _on_queue_updated(self, data: dict):
        self.queue = data.get("queue", [])
        await self._refresh_queue()

    async def _on_playback_state(self, data: dict):
        self.playback = PlaybackState.from_dict(data)
        self._refresh_now_playing()
        await self._apply_playback()

    async def _on_chat_message(self, data: dict):
        uname = data.get("username", "?")
        text = data.get("text", "")
        self._post_chat(uname, text)

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

    def _post_chat(self, username: str, text: str):
        log = self.query_one("#chat-log", RichLog)
        t = Text()
        t.append(f"{username} ", style="bold green")
        t.append(text)
        log.write(t)

    def _post_system(self, text: str):
        log = self.query_one("#chat-log", RichLog)
        t = Text(text, style="dim italic")
        log.write(t)

    def _check_player_status(self):
        """Polls the mpv process to auto-skip when a track ends naturally or crashes."""
        if not self.is_host or not self.playback.is_playing:
            return
        if self.player and self.player.proc and self.player.proc.poll() is not None:
            self.player.proc = None
            self.player_running = False
            asyncio.create_task(self._trigger_ended())

    async def _apply_playback(self):
        """Syncs the python-mpv player instance with the server playback state."""
        if not getattr(self, "player", None):
            return
            
        s = self.playback
        if not s.video_id:
            self.player.stop()
            self.last_video_id = None
            self.player_running = False
            return
            
        needs_play = s.is_playing and (s.video_id != self.last_video_id or not self.player_running)

        if needs_play:
            stream_url = self.stream_cache.get(s.video_id)
            stream_error: str | None = None
            if not stream_url:
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
            else:
                detail = f" {stream_error}" if stream_error else ""
                self._post_system(f"Failed to load stream for track.{detail}")
                if self.is_host:
                    await self._trigger_ended()

        elif not s.is_playing and self.player_running:
            self.player.stop()
            self.player_running = False

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
        results = await search_youtube(self.server_url, query)
        self.search_results = results
        lv = self.query_one("#search-results", ListView)
        await lv.clear()
        for r in results:
            await lv.append(SearchResultItem(r))
        inp.value = ""

    async def _do_send_chat(self):
        inp = self.query_one("#chat-input", Input)
        text = inp.value.strip()
        if not text:
            return
            
        if text.startswith("/host "):
            if not self.is_host:
                self._post_system("Only the host can transfer privileges.")
            else:
                new_host = text[6:].strip()
                await self.socket.transfer_host(self.room_id, new_host)
            inp.value = ""
            return

        await self.socket.send_chat(self.room_id, self.username, self.username, text)
        inp.value = ""

    # ── list selection — queue and search results ──────────────────────────
    async def on_list_view_selected(self, event: ListView.Selected):
        lv_id = event.list_view.id

        if lv_id == "search-results":
            idx = event.list_view.index
            if idx is not None and idx < len(self.search_results):
                r = self.search_results[idx]
                await self.socket.add_to_queue(
                    self.room_id, r.video_id, r.title, r.channel, r.thumbnail
                )
                self._post_system(f"added: {r.title[:40]}")

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
            self._post_system("Only the host can skip tracks.")
            return
        if self.playback.video_id:
            self._post_system("Skipped track.")
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
        self._post_system(f"Volume: {self.volume}%")

    def action_volume_up(self):
        self.volume = min(100, self.volume + 10)
        if getattr(self, "player", None):
            self.player.set_volume(self.volume)
        self._post_system(f"Volume: {self.volume}%")

    def action_info(self) -> None:
        self.push_screen(InfoModal(in_room=True))

    def action_show_listeners(self) -> None:
        if not self.is_host:
            self._post_system("Only the host can view the listener list.")
            return
        self.push_screen(ListenersModal(self.members, self._transfer_host_from_modal))

    async def _transfer_host_from_modal(self, user_id: str) -> None:
        await self.socket.transfer_host(self.room_id, user_id)