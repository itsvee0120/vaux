"""
REST API client for vaux server endpoints.
Currently covers YouTube search; extend as new endpoints are added.
"""

import httpx
import json
import os
import re
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


# "web" first (server/index.js's chain leads with "tv,web_safari,mweb,default"
# instead): kept from debugging a since-fixed yt-dlp bug where "default"
# resolved to the "android_vr" client, whose URLs 403'd in mpv regardless of
# headers (fixed by upgrading yt-dlp — see _get_stream_local's docstring).
# "web" first is still a reasonable, low-bot-wall-risk default for a
# residential IP; the rest of the chain remains as a fallback.
YTDLP_PLAYER_CLIENT_CHAINS = [
    "web",
    "tv,web_safari,mweb,default",
    "web_embedded,tv_embedded",
    "mweb",
]


def _ytdlp_base_args(player_clients: str) -> list[str]:
    """Flags required for modern YouTube extraction (JS challenges + EJS)."""
    args = [
        "--remote-components",
        "ejs:github",
        "--extractor-args",
        f"youtube:player_client={player_clients}",
    ]
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


def _classify_ytdlp_error(stderr: str) -> tuple[str, str]:
    """Classify local yt-dlp stderr into (code, message).

    Mirrors server/index.js's classifyYtDlpError so local and server failures
    get the same treatment; bot-challenge here means the pip-installed yt-dlp
    is stale, so the fix is an upgrade rather than a server retry.
    """
    if re.search(r"confirm you.?re not a bot", stderr, re.IGNORECASE):
        return "bot_challenge", (
            "YouTube blocked local extraction (bot challenge). "
            "Try: pip install -U yt-dlp"
        )
    if re.search(
        r"private video|members.only|age.restricted|unavailable|removed|not available",
        stderr,
        re.IGNORECASE,
    ):
        return "unavailable", "Video unavailable or restricted on YouTube."
    return "unknown", _parse_ytdlp_error(stderr)


async def _get_stream_from_server(
    server_url: str, video_id: str
) -> tuple[str | None, str | None, str | None, str | None]:
    """Ask the vaux server to resolve a stream URL via its bundled yt-dlp.

    Returns (stream_url, error_message, error_code, source_label).
    """
    url = f"{server_url.rstrip('/')}/youtube/stream"
    headers = _api_headers()
    try:
        async with httpx.AsyncClient(headers=headers) as client:
            # Keep this short so we can quickly fall back to local yt-dlp
            # when Render's extractor is bot-gated/slow.
            resp = await client.get(
                url,
                params={"videoId": video_id},
                timeout=12.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                stream_url = data.get("url", "").strip()
                if stream_url:
                    source = "server-cache" if data.get("cached") else "server-live"
                    return stream_url, None, None, source
                return None, "server returned empty stream URL", "unknown", None
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
            return None, f"server: {detail}", code, None
    except Exception as exc:
        return None, f"server unreachable: {exc}", None, None


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


async def _get_stream_local(
    video_id: str,
) -> tuple[str | None, dict[str, str] | None, str | None]:
    """Resolve stream URL with local yt-dlp (user IP — reliable vs datacenter).

    Retries YTDLP_PLAYER_CLIENT_CHAINS the same way server/index.js's
    ytdlpExecWithClientChains does: keep trying the next client set on any
    non-bot-challenge failure, but stop immediately on a bot-challenge
    classification (matches the server's stopOnBotChallenge=true behavior).
    Infra-level failures (binary missing, timeout, subprocess error) return
    immediately without looping, since a different client won't fix those.

    Returns (stream_url, headers, error_message). Player clients sign the
    returned URL to only accept requests carrying the same User-Agent and
    other request headers (Accept, Accept-Language, Sec-Fetch-Mode, etc.)
    yt-dlp used to resolve it — opening it with mpv's defaults instead gets
    a 403 from the CDN. headers must be forwarded to the player when
    present.

    Note: an earlier version of this function rejected any resolution that
    didn't come from the "web" client, because on a since-fixed yt-dlp bug
    (yt-dlp defaulted to the "android_vr" client, whose URLs 403'd in mpv
    regardless of headers) that was the only client that reliably worked.
    Upgrading yt-dlp (2026.08.19+, which dropped android_vr from its
    defaults) fixed the underlying issue — any client's resolution now
    plays correctly once its headers are forwarded, so that rejection was
    removed.
    """
    ytdlp = _get_ytdlp_exe()
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    last_error = "unknown yt-dlp error"

    for player_clients in YTDLP_PLAYER_CLIENT_CHAINS:
        try:
            proc = await asyncio.create_subprocess_exec(
                ytdlp,
                *_ytdlp_base_args(player_clients),
                "--print",
                "urls",
                "--print",
                "%(http_headers)j",
                "--no-warnings",
                "-f",
                "bestaudio/best",
                watch_url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            return None, None, f"yt-dlp not found at {ytdlp}"
        except Exception as exc:
            return None, None, str(exc)

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
        except asyncio.CancelledError:
            await _drain_subprocess(proc)
            raise
        except asyncio.TimeoutError:
            await _drain_subprocess(proc)
            return None, None, "yt-dlp timed out"
        except Exception as exc:
            await _drain_subprocess(proc)
            return None, None, str(exc)

        if proc.returncode == 0:
            out_lines = stdout.decode("utf-8", errors="ignore").strip().splitlines()
            if out_lines and out_lines[0].startswith("http"):
                url = out_lines[0]
                headers: dict[str, str] | None = None
                if len(out_lines) > 1:
                    try:
                        parsed = json.loads(out_lines[1])
                        if isinstance(parsed, dict):
                            headers = {
                                k: v
                                for k, v in parsed.items()
                                if isinstance(k, str) and isinstance(v, str) and v
                            } or None
                    except ValueError:
                        pass
                return url, headers, None
            last_error = "yt-dlp returned no stream URL"
            continue

        err_text = stderr.decode("utf-8", errors="ignore")
        code, message = _classify_ytdlp_error(err_text)
        last_error = message
        if code == "bot_challenge":
            break

    return None, None, last_error


async def get_stream_url(
    server_url: str, video_id: str
) -> tuple[str | None, str | None, str | None, dict[str, str] | None]:
    """Resolve a direct audio stream URL — local yt-dlp first, server fallback.

    Returns (stream_url, error_message, source_label, headers). headers is
    only set for local-ytdlp results (see _get_stream_local) and must be
    forwarded to the player, or some URLs 403 when opened.
    Local extraction uses the user's residential IP and avoids Render bot walls.
    Server is only consulted when local yt-dlp is missing or fails.
    """
    stream_url, headers, local_error = await _get_stream_local(video_id)
    if stream_url:
        return stream_url, None, "local-ytdlp", headers

    stream_url, server_error, server_code, source = await _get_stream_from_server(
        server_url, video_id
    )
    if stream_url:
        return stream_url, None, source, None

    parts = [part for part in (local_error, server_error) if part]
    if server_code == "bot_challenge" and not local_error:
        parts.append("install or update local yt-dlp (pip install -U yt-dlp)")
    return None, " | ".join(parts) if parts else "could not resolve stream", None, None
