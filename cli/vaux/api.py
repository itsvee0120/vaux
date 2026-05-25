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

# Public dev gate for /youtube routes — not a secret; blocks casual bot scans.
DEFAULT_API_KEY = "vaux-02187xdsx-4335"
API_KEY = os.environ.get("VAUX_API_KEY", DEFAULT_API_KEY)


def _api_headers() -> dict[str, str]:
    return {"x-api-key": API_KEY}

_NODE_PATH: str | None = shutil.which("node")


@dataclass
class SearchResult:
    video_id: str
    title: str
    channel: str
    thumbnail: str


async def ping_server(server_url: str, timeout: float = 30.0) -> None:
    """Fire-and-forget GET to /health to wake a cold-started server.

    Free-tier hosts can take 10–30s to spin up after idle, which would otherwise
    show up as a search timeout on the user's first action. Errors are swallowed
    — this is a best-effort warm-up, not a hard dependency.
    """
    url = f"{server_url.rstrip('/')}/health"
    try:
        async with httpx.AsyncClient() as client:
            await client.get(url, timeout=timeout)
    except Exception:
        pass


async def search_youtube(server_url: str, query: str) -> list[SearchResult]:
    """Hits the server-side YouTube search proxy and returns results."""
    url = f"{server_url.rstrip('/')}/youtube/search"
    headers = _api_headers()
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


def _ytdlp_base_args() -> list[str]:
    """Flags required for modern YouTube extraction (JS challenges + EJS)."""
    args = ["--remote-components", "ejs:github"]
    if _NODE_PATH:
        args.extend(["--js-runtimes", "node"])
    return args


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


def _parse_ytdlp_error(stderr: str) -> str:
    """Pull the most useful line from yt-dlp stderr."""
    for line in stderr.splitlines():
        if line.startswith("ERROR:"):
            return line.removeprefix("ERROR:").strip()
        if "No supported JavaScript runtime" in line:
            return (
                "Missing JS runtime for yt-dlp (Node.js on PATH, or: pip install -U yt-dlp)"
            )
    cleaned = stderr.strip()
    if cleaned:
        return cleaned.splitlines()[-1]
    return "unknown yt-dlp error"


async def _get_stream_from_server(
    server_url: str, video_id: str
) -> tuple[str | None, str | None]:
    """Ask the vaux server to resolve a stream URL via its bundled yt-dlp."""
    url = f"{server_url.rstrip('/')}/youtube/stream"
    headers = _api_headers()
    try:
        async with httpx.AsyncClient(headers=headers) as client:
            resp = await client.get(
                url,
                params={"videoId": video_id},
                timeout=45.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                stream_url = data.get("url", "").strip()
                if stream_url:
                    return stream_url, None
                return None, "server returned empty stream URL"
            try:
                detail = resp.json().get("error", resp.text)
            except Exception:
                detail = resp.text or f"HTTP {resp.status_code}"
            return None, f"server: {detail}"
    except Exception as exc:
        return None, f"server unreachable: {exc}"


async def _get_stream_local(video_id: str) -> tuple[str | None, str | None]:
    """Fallback: resolve stream URL with local yt-dlp."""
    ytdlp = _get_ytdlp_exe()
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    last_error: str | None = None

    try:
        proc = await asyncio.create_subprocess_exec(
            ytdlp,
            *_ytdlp_base_args(),
            "--get-url",
            "--no-warnings",
            "-f",
            "bestaudio/best",
            watch_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
        if proc.returncode != 0:
            err_text = stderr.decode("utf-8", errors="ignore")
            return None, _parse_ytdlp_error(err_text)
        url = stdout.decode("utf-8", errors="ignore").strip().splitlines()
        if url and url[0].startswith("http"):
            return url[0], None
        last_error = "yt-dlp returned no stream URL"
    except asyncio.TimeoutError:
        last_error = "yt-dlp timed out"
    except Exception as exc:
        last_error = str(exc)

    return None, last_error


async def get_stream_url(
    server_url: str, video_id: str
) -> tuple[str | None, str | None]:
    """Resolve a direct audio stream URL — server first, then local yt-dlp.

    Returns (stream_url, error_message). Only one of the two will be set.
    """
    stream_url, server_error = await _get_stream_from_server(server_url, video_id)
    if stream_url:
        return stream_url, None

    stream_url, local_error = await _get_stream_local(video_id)
    if stream_url:
        return stream_url, None

    parts = [part for part in (server_error, local_error) if part]
    return None, " | ".join(parts) if parts else "could not resolve stream"
