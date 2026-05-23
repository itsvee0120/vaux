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
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal, Vertical, ScrollableContainer
from textual.widgets import (
    Header, Footer, Input, Button, Label, ListView,
    ListItem, Static, RichLog,
)
from textual.reactive import reactive

from vaux.socket_client import VauxSocket
from vaux.playback import PlaybackState
from vaux.api import search_youtube, SearchResult


# ── NowPlaying widget ──────────────────────────────────────────────────────
class NowPlaying(Static):
    """Displays current track info and synced position."""

    state: reactive[PlaybackState] = reactive(PlaybackState, recompose=False)

    def __init__(self, **kwargs):
        super().__init__("", **kwargs)
        self._state = PlaybackState()
        self._ticker_task: asyncio.Task | None = None

    def on_mount(self):
        self._ticker_task = asyncio.get_event_loop().create_task(self._tick())

    def on_unmount(self):
        if self._ticker_task:
            self._ticker_task.cancel()

    async def _tick(self):
        """Refreshes the position display every second."""
        while True:
            await asyncio.sleep(1)
            self._render_state()

    def update_state(self, state: PlaybackState):
        self._state = state
        self._render_state()

    def _render_state(self):
        s = self._state
        if not s.video_id:
            self.update("◼  no track playing")
            return
        icon = "▶" if s.is_playing else "⏸"
        pos = s.formatted_position()
        title = (s.title or "")[:50]
        channel = s.channel or ""
        self.update(f"{icon}  {title}\n    {channel}  [{pos}]")


# ── QueueItem widget ───────────────────────────────────────────────────────
class QueueItem(ListItem):
    def __init__(self, item: dict, is_host: bool):
        super().__init__()
        self._item = item
        self._is_host = is_host

    def compose(self) -> ComposeResult:
        title = (self._item.get("title") or "")[:40]
        votes = self._item.get("votes", 0)
        added_by = self._item.get("addedBy", "")
        vote_str = f"+{votes}" if votes >= 0 else str(votes)
        host_marker = " [host ▶]" if self._is_host else ""
        yield Label(f"{vote_str}  {title}  — {added_by}{host_marker}")


# ── SearchResultItem widget ────────────────────────────────────────────────
class SearchResultItem(ListItem):
    def __init__(self, result: SearchResult):
        super().__init__()
        self.result = result

    def compose(self) -> ComposeResult:
        title = result.title[:50] if (result := self.result) else ""
        channel = self.result.channel
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
        width: 40;
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
        Binding("ctrl+s", "focus_search", "Search", show=True),
        Binding("ctrl+t", "focus_chat", "Chat", show=True),
        Binding("up", "vote_up", "Vote ▲", show=False),
        Binding("down", "vote_down", "Vote ▼", show=False),
        Binding("enter", "select", "Select", show=False),
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

    async def on_unmount(self):
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

    def _on_room_joined(self, data: dict):
        self.role = data.get("role", "listener")
        self.is_host = self.role == "host"
        self.members = data.get("members", [])
        self.queue = data.get("queue", [])
        pb = data.get("playbackState") or {}
        self.playback = PlaybackState.from_dict(pb)
        self.call_from_thread(self._refresh_queue)
        self.call_from_thread(self._refresh_now_playing)
        self.call_from_thread(self._post_system, f"joined [{self.role}]")

    def _on_member_joined(self, data: dict):
        uname = data.get("username", "?")
        self.call_from_thread(self._post_system, f"{uname} joined")

    def _on_member_left(self, data: dict):
        uid = data.get("userId", "?")
        self.call_from_thread(self._post_system, f"{uid} left")

    def _on_host_changed(self, data: dict):
        new_host_id = data.get("newHostId")
        self.is_host = new_host_id == self.username
        self.role = "host" if self.is_host else "listener"
        new_name = data.get("newHostUsername", new_host_id)
        self.call_from_thread(self._post_system, f"⭐ {new_name} is now host")
        self.call_from_thread(self._refresh_queue)

    def _on_queue_updated(self, data: dict):
        self.queue = data.get("queue", [])
        self.call_from_thread(self._refresh_queue)

    def _on_playback_state(self, data: dict):
        self.playback = PlaybackState.from_dict(data)
        self.call_from_thread(self._refresh_now_playing)

    def _on_chat_message(self, data: dict):
        uname = data.get("username", "?")
        text = data.get("text", "")
        self.call_from_thread(self._post_chat, uname, text)

    def _on_reaction(self, data: dict):
        emoji = data.get("emoji", "")
        self.call_from_thread(self._post_system, emoji)

    # ── UI refresh helpers ─────────────────────────────────────────────────
    def _refresh_queue(self):
        lv = self.query_one("#queue-list", ListView)
        lv.clear()
        for item in self.queue:
            lv.append(QueueItem(item, self.is_host))

    def _refresh_now_playing(self):
        widget = self.query_one("#now-playing", NowPlaying)
        widget.update_state(self.playback)

    def _post_chat(self, username: str, text: str):
        log = self.query_one("#chat-log", RichLog)
        log.write(f"[bold green]{username}[/] {text}")

    def _post_system(self, text: str):
        log = self.query_one("#chat-log", RichLog)
        log.write(f"[dim italic]{text}[/]")

    # ── button handlers ────────────────────────────────────────────────────
    async def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "search-btn":
            await self._do_search()
        elif event.button.id == "chat-btn":
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
        lv.clear()
        for r in results:
            lv.append(SearchResultItem(r))
        inp.value = ""

    async def _do_send_chat(self):
        inp = self.query_one("#chat-input", Input)
        text = inp.value.strip()
        if not text:
            return
        await self.socket.send_chat(self.room_id, self.username, self.username, text)
        inp.value = ""

    # ── list selection — queue and search results ──────────────────────────
    async def on_list_view_selected(self, event: ListView.Selected):
        lv_id = event.list_view.id

        if lv_id == "search-results":
            # add selected result to queue
            idx = event.list_view.index
            if idx is not None and idx < len(self.search_results):
                r = self.search_results[idx]
                await self.socket.add_to_queue(
                    self.room_id, r.video_id, r.title, r.channel, r.thumbnail
                )
                self._post_system(f"added: {r.title[:40]}")

        elif lv_id == "queue-list" and self.is_host:
            # host pressing enter on a queue item plays it immediately
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