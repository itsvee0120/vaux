"""
REST API client for vaux server endpoints.
Currently covers YouTube search; extend as new endpoints are added.
"""

import httpx
from dataclasses import dataclass


@dataclass
class SearchResult:
    video_id: str
    title: str
    channel: str
    thumbnail: str


async def search_youtube(server_url: str, query: str) -> list[SearchResult]:
    """Hits the server-side YouTube search proxy and returns results."""
    url = f"{server_url}/youtube/search"
    async with httpx.AsyncClient() as client:
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