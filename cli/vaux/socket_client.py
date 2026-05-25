"""
vaux socket client.

Wraps python-socketio and exposes the same event contract as the web client.
All callbacks receive the raw payload dict from the server.
"""

import asyncio
from typing import Callable
import socketio


class VauxSocket:
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.sio = socketio.AsyncClient()
        self._handlers: dict[str, list[Callable]] = {}

    # ── public event registration ──────────────────────────────────────────
    def on(self, event: str, handler: Callable):
        if event not in self._handlers:
            self._handlers[event] = []
            self.sio.on(event, self._make_dispatcher(event))
        self._handlers[event].append(handler)

    def _make_dispatcher(self, event: str):
        async def dispatch(*args):
            data = args[0] if args else {}
            for h in self._handlers.get(event, []):
                if asyncio.iscoroutinefunction(h):
                    await h(data)
                else:
                    h(data)
        return dispatch

    # ── connection ─────────────────────────────────────────────────────────
    async def connect(self):
        await self.sio.connect(self.server_url, transports=["websocket", "polling"])

    async def disconnect(self):
        await self.sio.disconnect()

    # ── emit helpers — mirrors web client emit calls ───────────────────────
    async def join_room(self, room_id: str, user_id: str, username: str):
        await self.sio.emit("room:join", {
            "roomId": room_id,
            "userId": user_id,
            "username": username,
        })

    async def send_chat(self, room_id: str, user_id: str, username: str, text: str):
        await self.sio.emit("chat:send", {
            "roomId": room_id,
            "userId": user_id,
            "username": username,
            "text": text,
        })

    async def add_to_queue(self, room_id: str, video_id: str, title: str,
                           channel: str, thumbnail: str, duration: float = 0.0):
        await self.sio.emit("queue:add", {
            "roomId": room_id,
            "videoId": video_id,
            "title": title,
            "channel": channel,
            "thumbnail": thumbnail,
            "duration": duration,
        })

    async def vote(self, room_id: str, item_id: str, value: int):
        await self.sio.emit("queue:vote", {
            "roomId": room_id,
            "itemId": item_id,
            "value": value,
        })

    async def remove_from_queue(self, room_id: str, item_id: str):
        await self.sio.emit("queue:remove", {
            "roomId": room_id,
            "itemId": item_id,
        })

    async def play(self, room_id: str, position_seconds: float):
        await self.sio.emit("playback:play", {
            "roomId": room_id,
            "positionSeconds": position_seconds,
        })

    async def pause(self, room_id: str, position_seconds: float):
        await self.sio.emit("playback:pause", {
            "roomId": room_id,
            "positionSeconds": position_seconds,
        })

    async def seek(self, room_id: str, position_seconds: float):
        await self.sio.emit("playback:seek", {
            "roomId": room_id,
            "positionSeconds": position_seconds,
        })

    async def play_track(self, room_id: str, item_id: str):
        await self.sio.emit("playback:play_track", {
            "roomId": room_id,
            "itemId": item_id,
        })

    async def ended(self, room_id: str):
        await self.sio.emit("playback:ended", {"roomId": room_id})

    async def transfer_host(self, room_id: str, new_host_id: str):
        await self.sio.emit("host:transfer", {
            "roomId": room_id,
            "newHostId": new_host_id,
        })

    async def send_reaction(self, room_id: str, emoji: str):
        await self.sio.emit("reaction:send", {
            "roomId": room_id,
            "emoji": emoji,
        })