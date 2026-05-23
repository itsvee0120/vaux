"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    vaux
    vaux join <room-id> <username>
"""

import sys
import os
import shutil
import tempfile
import json
import io
import zipfile
import subprocess
import urllib.request
from importlib.metadata import version, PackageNotFoundError

import click
from vaux.app import VauxApp, LobbyApp

# ----------------------------------------------------------------------
# Version
# ----------------------------------------------------------------------
try:
    __version__ = version("vaux-cli")
except PackageNotFoundError:
    __version__ = "dev"

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------
SERVER_URL = "https://vaux.onrender.com"
VENDOR_DIR = os.path.expanduser("~/.vaux/mpv")


def _add_vendor_to_path():
    os.environ["PATH"] = VENDOR_DIR + os.pathsep + os.environ.get("PATH", "")


# ----------------------------------------------------------------------
# MPV bootstrap (OFFLINE-FIRST, NO NETWORK AFTER INSTALL)
# ----------------------------------------------------------------------
def ensure_mpv():
    """
    Ensures mpv is available.

    Priority:
    1. system mpv
    2. ~/.vaux/mpv/mpv.exe
    3. download GitHub release (Windows only)
    """

    mpv_exe = "mpv.exe" if sys.platform == "win32" else "mpv"

    # 1. system install
    if shutil.which(mpv_exe):
        return

    mpv_path = os.path.join(VENDOR_DIR, mpv_exe)

    # 2. cached install
    if os.path.exists(mpv_path):
        _add_vendor_to_path()
        return

    # 3. non-windows fallback
    if sys.platform != "win32":
        click.echo("mpv required: https://mpv.io/installation/")
        sys.exit(1)

    if not click.confirm("mpv not found. Download it automatically?"):
        sys.exit(1)

    click.echo("Fetching latest mpv build...")

    try:
        api_url = "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest"

        req = urllib.request.Request(api_url, headers={"User-Agent": "vaux-cli"})
        with urllib.request.urlopen(req, timeout=30) as r:
            release = json.loads(r.read().decode())

        assets = release.get("assets", [])

        # ----------------------------------------------------------
        # prefer x86_64-v3 builds (highly preferring .zip)
        # ----------------------------------------------------------
        def score(a):
            name = a["name"]
            return (
                ("x86_64-v3" in name) * 100 +
                ("x86_64" in name) * 10 +
                (name.endswith(".zip")) * 50 +
                (name.endswith(".7z")) * 1
            )

        assets.sort(key=score, reverse=True)

        url = next(
            (
                a["browser_download_url"]
                for a in assets
                if "x86_64" in a["name"] and a["name"].endswith((".7z", ".zip"))
            ),
            None,
        )

        if not url:
            raise RuntimeError("No compatible mpv build found")

        os.makedirs(VENDOR_DIR, exist_ok=True)

        click.echo(f"Downloading {url.split('/')[-1]}")

        req = urllib.request.Request(url, headers={"User-Agent": "vaux-cli"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()

        archive = io.BytesIO(data)

        # ----------------------------------------------------------
        # ZIP extraction
        # ----------------------------------------------------------
        if url.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                for f in z.infolist():
                    if f.filename.endswith("mpv.exe"):
                        with z.open(f) as src, open(mpv_path, "wb") as dst:
                            shutil.copyfileobj(src, dst)
                        break

        # ----------------------------------------------------------
        # 7Z extraction
        # ----------------------------------------------------------
        else:
            import py7zr
            with py7zr.SevenZipFile(io.BytesIO(data)) as z:
                all_files = z.getnames()
                mpv_entry = next((f for f in all_files if f.endswith("mpv.exe")), None)
                if not mpv_entry:
                    raise RuntimeError("mpv.exe not found in archive")
                z.extract(targets=[mpv_entry], path=VENDOR_DIR)
                # move to flat VENDOR_DIR if nested
                extracted_path = os.path.join(VENDOR_DIR, mpv_entry)
                if extracted_path != mpv_path:
                    shutil.move(extracted_path, mpv_path)

        click.echo("mpv installed successfully ✔")
        _add_vendor_to_path()

    except Exception as e:
        click.echo(f"mpv setup failed: {e}")
        sys.exit(1) 

# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------
@click.group(invoke_without_command=True)
@click.option("--server", default=SERVER_URL, show_default=True, help="Vaux server URL.")
@click.option("--debug", is_flag=True, help="Enable debug output.")
@click.option("-u", "--username", help="Your display name (used for quick join).")
@click.option("--version", is_flag=True, is_eager=True, help="Show version and exit.")
@click.option("--path", is_flag=True, is_eager=True, help="Show the paths to the vaux and mpv folders and exit.")
@click.argument("room_id", required=False)
@click.pass_context
def cli(ctx, server, debug, username, version, path, room_id):
    """
    Vaux — synchronized listening rooms in the terminal.

    Examples:

      vaux
          Open interactive lobby

      vaux <room-id> -u <name>
          Quick join a room

      vaux join <room-id> <username>
          Explicit join mode
    """

    ensure_mpv()

    # ------------------------
    # version
    # ------------------------
    if version:
        click.echo(f"vaux {__version__}")
        return

    # ------------------------
    # path
    # ------------------------
    if path:
        click.echo(f"Vaux data folder: {os.path.dirname(VENDOR_DIR)}")
        click.echo(f"MPV folder: {VENDOR_DIR}")
        return

    # ------------------------
    # subcommand mode
    # ------------------------
    if ctx.invoked_subcommand is not None:
        return

    # ------------------------
    # quick join
    # ------------------------
    if room_id and username:
        VauxApp(
            room_id=room_id,
            username=username,
            server_url=server,
        ).run()
        return

    # ------------------------
    # lobby fallback
    # ------------------------
    lobby = LobbyApp(server_url=server)
    lobby.run()

    if lobby.result is None:
        return

    room_id, username = lobby.result

    VauxApp(
        room_id=room_id,
        username=username,
        server_url=server,
    ).run()

if __name__ == "__main__":
    cli()