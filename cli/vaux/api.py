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
    duration: float = 0.0


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


def _format_api_error(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        code = data.get("code")
        msg = data.get("error") or resp.text or f"HTTP {resp.status_code}"
        if code == "bot_challenge":
            return (
                "YouTube blocked server search (bot challenge). "
                "Retry in a few seconds."
            )
        return str(msg)
    except Exception:
        return resp.text or f"HTTP {resp.status_code}"


async def search_youtube(
    server_url: str, query: str, *, retries: int = 3
) -> list[SearchResult]:
    """Hits the server-side YouTube search proxy and returns results."""
    url = f"{server_url.rstrip('/')}/youtube/search"
    headers = _api_headers()
    last_error: Exception | None = None

    for attempt in range(retries):
        timeout = 15.0 + attempt * 10.0
        try:
            async with httpx.AsyncClient(headers=headers) as client:
                resp = await client.get(
                    url, params={"q": query}, timeout=timeout
                )
                if resp.status_code >= 400:
                    raise httpx.HTTPStatusError(
                        _format_api_error(resp),
                        request=resp.request,
                        response=resp,
                    )
                data = resp.json()
            return [
                SearchResult(
                    video_id=r["videoId"],
                    title=r["title"],
                    channel=r["channel"],
                    thumbnail=r["thumbnail"],
                    duration=r.get("duration", 0.0) or 0.0,
                )
                for r in data.get("results", [])
            ]
        except Exception as exc:
            last_error = exc
            if attempt < retries - 1:
                await asyncio.sleep(0.75 * (attempt + 1))
                continue
            raise last_error from exc

    raise RuntimeError("search failed")


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
) -> tuple[str | None, str | None, str | None]:
    """Ask the vaux server to resolve a stream URL via its bundled yt-dlp.

    Returns (stream_url, error_message, error_code).
    """
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
                    return stream_url, None, None
                return None, "server returned empty stream URL", "unknown"
            try:
                data = resp.json()
                code = data.get("code")
                detail = data.get("error") or resp.text
            except Exception:
                code = None
                detail = resp.text or f"HTTP {resp.status_code}"
            if code == "bot_challenge":
                detail = (
                    "YouTube blocked server stream extraction (bot challenge)"
                )
            return None, f"server: {detail}", code
    except Exception as exc:
        return None, f"server unreachable: {exc}", None


async def _drain_subprocess(proc: asyncio.subprocess.Process) -> None:
    """Force-close an asyncio subprocess + its pipe transports.

    On Windows ProactorEventLoop, if communicate() is cancelled (e.g. by
    wait_for timing out), the stdout/stderr read tasks die mid-flight and the
    _ProactorBasePipeTransport objects are left in a half-closed state. Their
    __del__ later raises ResourceWarning, and the warning's __repr__ call
    crashes with "I/O operation on closed pipe" — the noisy traceback the
    user sees. Killing + re-communicating gives the transports a chance to
    run their close() callbacks on the still-live loop.
    """
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        except Exception:
            pass
    try:
        await proc.communicate()
    except Exception:
        pass


async def _get_stream_local(video_id: str) -> tuple[str | None, str | None]:
    """Fallback: resolve stream URL with local yt-dlp."""
    ytdlp = _get_ytdlp_exe()
    watch_url = f"https://www.youtube.com/watch?v={video_id}"

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
    except FileNotFoundError:
        return None, f"yt-dlp not found at {ytdlp}"
    except Exception as exc:
        return None, str(exc)

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
    except asyncio.TimeoutError:
        await _drain_subprocess(proc)
        return None, "yt-dlp timed out"
    except Exception as exc:
        await _drain_subprocess(proc)
        return None, str(exc)

    if proc.returncode != 0:
        err_text = stderr.decode("utf-8", errors="ignore")
        return None, _parse_ytdlp_error(err_text)
    url_lines = stdout.decode("utf-8", errors="ignore").strip().splitlines()
    if url_lines and url_lines[0].startswith("http"):
        return url_lines[0], None
    return None, "yt-dlp returned no stream URL"


async def get_stream_url(
    server_url: str, video_id: str
) -> tuple[str | None, str | None]:
    """Resolve a direct audio stream URL — server first, then local yt-dlp.

    Returns (stream_url, error_message). Only one of the two will be set.
    On server bot_challenge, tries local yt-dlp immediately.
    """
    stream_url, server_error, server_code = await _get_stream_from_server(
        server_url, video_id
    )
    if stream_url:
        return stream_url, None

    stream_url, local_error = await _get_stream_local(video_id)
    if stream_url:
        return stream_url, None

    parts = [part for part in (server_error, local_error) if part]
    if server_code == "bot_challenge" and not local_error:
        parts.append("install or update local yt-dlp (pip install -U yt-dlp)")
    return None, " | ".join(parts) if parts else "could not resolve stream"
