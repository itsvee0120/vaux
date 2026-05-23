"""
REST API client for vaux server endpoints.
Currently covers YouTube search; extend as new endpoints are added.
"""

import httpx
import os
import sys
import shutil
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


def _get_ytdlp_exe() -> str:
    """Find yt-dlp executable, preferring venv then PATH then vendor dir."""
    exe = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"

    if sys.prefix:
        scripts = "Scripts" if sys.platform == "win32" else "bin"
        venv_path = os.path.join(sys.prefix, scripts, exe)
        if os.path.exists(venv_path):
            return venv_path

    if found := (shutil.which(exe) or shutil.which("yt-dlp")):
        return found

    vendor_path = os.path.join(os.path.expanduser("~/.vaux/mpv"), exe)
    if os.path.exists(vendor_path):
        return vendor_path

    return exe


async def get_stream_url(server_url: str, video_id: str) -> str | None:
    """Resolves the direct audio stream URL locally using yt-dlp."""
    ytdlp = _get_ytdlp_exe()

    strategies = [
        ["--extractor-args", "youtube:player_client=android_vr"],
        ["-f", "bestaudio/best", "--cookies-from-browser", "firefox"],
        ["-f", "bestaudio/best", "--cookies-from-browser", "chrome"],
    ]

    for extra_args in strategies:
        try:
            proc = await asyncio.create_subprocess_exec(
                ytdlp, "--get-url", "--no-warnings",
                *extra_args,
                f"https://www.youtube.com/watch?v={video_id}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            url = stdout.decode("utf-8", errors="ignore").strip()
            if url:
                return url
        except Exception:
            continue

    return None