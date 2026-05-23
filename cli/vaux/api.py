"""
REST API client for vaux server endpoints.
Currently covers YouTube search; extend as new endpoints are added.
"""

import httpx
import os
from dataclasses import dataclass

API_KEY = os.environ.get("VAUX_API_KEY", "vaux-02187xdsx-4335")


@dataclass
class SearchResult:
    video_id: str
    title: str
    channel: str
    thumbnail: str


async def search_youtube(server_url: str, query: str) -> list[SearchResult]:
    """Hits the server-side YouTube search proxy and returns results."""
    url = f"{server_url}/youtube/search"
    headers = {"x-api-key": API_KEY}
    async with httpx.AsyncClient(headers=headers) as client:
        resp = await client.get(url, params={"q": query}, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()

    return [
        SearchResult(
            video_id=r["videoId"],
            title=r["title"],
            channel=r["channel"],
            thumbnail=r["thumbnail"],
        )
        for r in data.get("results", [])
    ]


async def get_stream_url(server_url: str, video_id: str) -> str | None:
    """Hits the server-side yt-dlp proxy to get a direct audio stream URL."""
    url = f"{server_url}/youtube/stream-url"
    headers = {"x-api-key": API_KEY}
    async with httpx.AsyncClient(headers=headers) as client:
        try:
            resp = await client.get(url, params={"videoId": video_id}, timeout=15.0)
            resp.raise_for_status()
            return resp.json().get("streamUrl")
        except Exception:
            return None