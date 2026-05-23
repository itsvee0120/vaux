"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    vaux
    vaux join <room-id> <username>
"""

import sys
import os
import shutil
import subprocess
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
# MPV bootstrap
# ----------------------------------------------------------------------
def ensure_mpv():
    """
    Ensures mpv is available.

    Priority:
    1. system mpv
    2. cached install (~/.vaux/mpv/mpv.exe)
    3. winget install (Windows only)
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

    click.echo("Installing mpv via winget...")
    winget = shutil.which("winget") or r"C:\Users\{}\AppData\Local\Microsoft\WindowsApps\winget.exe".format(os.environ.get("USERNAME", ""))
    
    if not os.path.exists(winget):
        click.echo(
            "\n[!] winget not found.\n\n"
            "Please install mpv manually:\n\n"
            "    winget install shinchiro.mpv\n\n"
            "Or download from: https://mpv.io/installation/\n"
        )
        sys.exit(1)

    result = subprocess.run(
        [winget, "install", "--id", "shinchiro.mpv", "-e",
         "--silent", "--accept-package-agreements", "--accept-source-agreements",
         "--override", f'/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="{VENDOR_DIR}"'],
        capture_output=False,
    )
    if result.returncode not in (0, -1978335189):
        click.echo(
            "\n[!] winget install failed.\n\n"
            "Please install mpv manually:\n\n"
            "    winget install shinchiro.mpv\n\n"
            "Or download from: https://mpv.io/installation/\n"
        )
        sys.exit(1)

    _add_vendor_to_path()

    if not shutil.which("mpv.exe"):
        # last resort: search VENDOR_DIR directly
        if not os.path.exists(mpv_path):
            click.echo("[!] mpv.exe not found after install. Please restart your terminal.")
            sys.exit(1)

    click.echo("mpv installed successfully ✔")

# ----------------------------------------------------------------------
# yt-dlp check
# ----------------------------------------------------------------------
def ensure_ytdlp():
    """yt-dlp is a package dependency, but warn if venv exe is missing."""
    ytdlp_exe = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"

    if sys.prefix:
        scripts = "Scripts" if sys.platform == "win32" else "bin"
        venv_path = os.path.join(sys.prefix, scripts, ytdlp_exe)
        if os.path.exists(venv_path):
            return

    if shutil.which(ytdlp_exe) or shutil.which("yt-dlp"):
        return

    click.echo(
        "[!] yt-dlp not found. Try reinstalling vaux-cli:\n\n"
        "    pip install --force-reinstall vaux-cli\n"
    )
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
    ensure_ytdlp()

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