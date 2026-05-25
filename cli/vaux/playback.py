"""
Playback sync — mirrors the web client's getSyncedPosition formula.

    currentPosition = positionSeconds + (now - updatedAt) / 1000

Both clients implement this identically so everyone stays in sync.
"""

import time
from dataclasses import dataclass, field


@dataclass
class PlaybackState:
    video_id: str | None = None
    title: str | None = None
    channel: str | None = None
    thumbnail: str | None = None
    track_id: str | None = None
    position_seconds: float = 0.0
    duration: float = 0.0
    is_playing: bool = False
    updated_at: float = field(default_factory=lambda: time.time() * 1000)

    @classmethod
    def from_dict(cls, data: dict) -> "PlaybackState":
        return cls(
            video_id=data.get("videoId"),
            title=data.get("title"),
            channel=data.get("channel"),
            thumbnail=data.get("thumbnail"),
            track_id=data.get("trackId"),
            position_seconds=data.get("positionSeconds", 0.0),
            duration=data.get("duration", 0.0),
            is_playing=data.get("isPlaying", False),
            updated_at=data.get("updatedAt", time.time() * 1000),
        )

    def synced_position(self) -> float:
        """Returns the current playback position accounting for elapsed time."""
        if not self.is_playing:
            return self.position_seconds
        elapsed = (time.time() * 1000 - self.updated_at) / 1000
        return self.position_seconds + elapsed

    def formatted_position(self) -> str:
        secs = int(self.synced_position())
        m, s = divmod(secs, 60)
        return f"{m}:{s:02d}"

    def formatted_duration(self) -> str:
        secs = int(self.duration)
        m, s = divmod(secs, 60)
        return f"{m}:{s:02d}"