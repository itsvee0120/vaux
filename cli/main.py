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
        api_url = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"

        req = urllib.request.Request(api_url, headers={"User-Agent": "vaux-cli"})
        with urllib.request.urlopen(req, timeout=30) as r:
            release = json.loads(r.read().decode())

        assets = release.get("assets", [])

        # ----------------------------------------------------------
        # prefer mpv-dev-x86_64-v3 builds
        # ----------------------------------------------------------
        def score(a):
            name = a["name"]
            return (
                ("mpv-dev-x86_64-v3" in name) * 100 +
                ("x86_64" in name) * 10 +
                (name.endswith(".7z")) * 5 +
                (name.endswith(".zip")) * 1
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
        # 7Z extraction (SYSTEM 7z FIRST)
        # ----------------------------------------------------------
        else:
            extracted = False

            # A. system 7z (recommended)
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    archive_path = os.path.join(tmp, "mpv.7z")

                    with open(archive_path, "wb") as f:
                        f.write(data)

                    subprocess.run(
                        ["7z", "x", "-y", f"-o{tmp}", archive_path],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )

                    for root, _, files in os.walk(tmp):
                        if "mpv.exe" in files:
                            shutil.copy2(os.path.join(root, "mpv.exe"), mpv_path)
                            extracted = True
                            break

            except FileNotFoundError:
                pass

            # B. fallback py7zr
            if not extracted:
                try:
                    import py7zr #type: ignore
                except ImportError:
                    click.echo(
                        "\nCannot extract .7z archive.\n"
                        "Install one of:\n"
                        "  - 7-Zip (recommended)\n"
                        "  - pip install py7zr\n"
                    )
                    sys.exit(1)

                with tempfile.TemporaryDirectory() as tmp:
                    with py7zr.SevenZipFile(archive, mode="r") as z:
                        z.extractall(path=tmp)

                    for root, _, files in os.walk(tmp):
                        if "mpv.exe" in files:
                            shutil.copy2(os.path.join(root, "mpv.exe"), mpv_path)
                            extracted = True
                            break

            if not extracted:
                raise RuntimeError("Failed to extract mpv.exe")

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
@click.argument("room_id", required=False)
@click.pass_context
def cli(ctx, server, debug, username, version, room_id):
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