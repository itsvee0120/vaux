"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    vaux
    vaux join <room-id> <username>
"""

import logging
import os
import shutil
import sys
from importlib.metadata import version, PackageNotFoundError

import click
from vaux.app import VauxApp, LobbyApp
from vaux.mpv import ensure_mpv

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
@click.option("--version", "show_version", is_flag=True, is_eager=True, help="Show version and exit.")
@click.option("--path", "show_path", is_flag=True, is_eager=True, help="Show vaux installation path and exit.")
@click.argument("room_id", required=False)
@click.pass_context
def cli(ctx, server, debug, username, show_version, show_path, room_id):
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

    if show_version:
        click.echo(f"vaux {__version__}")
        return

    if show_path:
        import vaux

        click.echo(os.path.dirname(vaux.__file__))
        return

    if debug:
        logging.basicConfig(level=logging.DEBUG)

    if ctx.invoked_subcommand is not None:
        return

    ensure_mpv()
    ensure_ytdlp()

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
    if room_id and not username:
        click.echo("Pass -u <name> to quick-join this room directly.")

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