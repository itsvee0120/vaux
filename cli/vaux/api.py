"""
REST API client for vaux server endpoints.
Currently covers YouTube search; extend as new endpoints are added.
"""

import httpx
import os
import asyncio
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
    """Resolves the direct audio stream URL locally using yt-dlp."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "-f", "bestaudio/best", "--get-url", "--no-warnings",
            f"https://www.youtube.com/watch?v={video_id}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        url = stdout.decode().strip()
        return url if url else None
    except Exception:
        return None