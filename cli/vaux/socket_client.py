"""
vaux socket client.

Wraps python-socketio and exposes the same event contract as the web client.
All callbacks receive the raw payload dict from the server.
"""

import asyncio
from typing import Callable
import socketio


async def probe_join(
    server_url: str,
    room_id: str,
    username,  # str for public, {"ct", "nonce"} dict for private
    *,
    is_private: bool = False,
    auth_proof_b64: str | None = None,
    create: bool = False,
    timeout: float = 6.0,
) -> str | None:
    """Validate credentials via room:join { probe: true } — no member row, no
    join/leave broadcasts. Returns None on success, else an error string."""
    sio = socketio.AsyncClient(reconnection=False)
    result: dict = {}
    done = asyncio.Event()

    @sio.on("room:joined")
    async def _ok(_):
        result["ok"] = True
        done.set()

    @sio.on("room:join_failed")
    async def _fail(data):
        result["reason"] = (data or {}).get("reason", "join refused")
        result["retryAfterMs"] = (data or {}).get("retryAfterMs")
        done.set()

    try:
        await sio.connect(server_url, transports=["websocket", "polling"])
        payload: dict = {"roomId": room_id, "username": username, "probe": True}
        if auth_proof_b64:
            payload["authProof"] = auth_proof_b64
            if create:
                payload["create"] = True
        await sio.emit("room:join", payload)
        await asyncio.wait_for(done.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        return "connection timed out — check the server"
    except Exception as exc:
        return str(exc) or "could not connect to server"
    finally:
        try:
            await sio.disconnect()
        except Exception:
            pass

    if result.get("ok"):
        return None

    reason = result.get("reason", "join refused")
    if is_private:
        # Collapse "wrong code" and "room not found" so the server isn't a
        # probe oracle for room existence. Matches VauxApp's wording.
        if reason == "auth_failed":
            return "wrong password, or this room no longer exists"
        if reason == "locked":
            ms = result.get("retryAfterMs") or 60_000
            return f"too many attempts — try again in {max(1, ms // 1000)}s"
        if reason in ("room full", "capacity"):
            return "private room is full"
    return reason


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
    async def join_room(
        self,
        room_id: str,
        username,
        *,
        auth_proof_b64: str | None = None,
        create: bool = False,
    ):
        """Public join: pass `username` as a plain string.
        Private join: pass `username` as `{"ct": <b64>, "nonce": <b64>}`
        (encrypted with chatKey) AND `auth_proof_b64`. The server branches on
        the presence of `authProof` — see PRIVATE_ROOMS_SPEC.md."""
        payload: dict = {"roomId": room_id, "username": username}
        if auth_proof_b64 is not None:
            payload["authProof"] = auth_proof_b64
            if create:
                payload["create"] = True
        await self.sio.emit("room:join", payload)

    async def send_chat(
        self,
        room_id: str,
        text: str | None = None,
        *,
        ct: str | None = None,
        nonce: str | None = None,
    ):
        """Public room: pass `text` (plaintext).
        Private room: pass `ct`/`nonce` (base64 ciphertext from encrypt_chat).
        Server relays opaquely — never inspects either form."""
        payload: dict = {"roomId": room_id}
        if ct is not None and nonce is not None:
            payload["ct"] = ct
            payload["nonce"] = nonce
        else:
            payload["text"] = text or ""
        await self.sio.emit("chat:send", payload)

    async def destroy_room(self, room_id: str):
        """Host-only burn for private rooms — server immediately deletes
        the room and force-disconnects all sockets. No-op on public rooms."""
        await self.sio.emit("room:destroy", {"roomId": room_id})

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