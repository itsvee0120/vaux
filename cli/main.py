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
from vaux.crypto import (
    auth_proof_to_b64,
    derive_room_material,
    is_well_formed_password,
    parse_invite,
)
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

    # `room_id` arg is a private invite URL (or raw 22-char password) when it
    # parses as one. We extract the password and route through the private
    # quick-join path. Public room names like "velvet-orbit-42" never match.
    invite_password: str | None = parse_invite(room_id) if room_id else None

    # ------------------------
    # quick join
    # ------------------------
    if room_id and username and not invite_password:
        VauxApp(
            room_id=room_id,
            username=username,
            server_url=server,
        ).run()
        return

    if invite_password and username:
        # Argon2id derivation is ~250 ms — block here so the user sees a
        # clean "deriving keys…" indicator before VauxApp's mount fires.
        click.echo("Deriving keys (argon2id)…", err=False)
        material = derive_room_material(invite_password)
        VauxApp(
            room_id=material.room_id,
            username=username,
            server_url=server,
            is_private=True,
            auth_proof_b64=auth_proof_to_b64(material.auth_proof),
            chat_key=material.chat_key,
            password=invite_password,
        ).run()
        return

    # ------------------------
    # lobby fallback
    # ------------------------
    if room_id and not username:
        click.echo("Pass -u <name> to quick-join this room directly.")

    # Pre-fill the private-paste tab if the user passed an invite URL but no
    # username — keeps them from having to paste twice.
    lobby = LobbyApp(server_url=server, initial_invite=invite_password)
    lobby.run()

    if lobby.result is None:
        return

    sel = lobby.result
    VauxApp(
        room_id=sel.room_id,
        username=sel.username,
        server_url=server,
        is_private=sel.is_private,
        auth_proof_b64=sel.auth_proof_b64,
        chat_key=sel.chat_key,
        password=sel.password,
        create_private=sel.create,
    ).run()

@cli.command()
def bug():
    """Report a bug — opens GitHub Issues in your browser (pre-filled)."""
    import webbrowser
    from vaux.app import build_github_issue_url

    url = build_github_issue_url(in_room=False)
    click.echo("Opening GitHub Issues in your browser...")
    if not webbrowser.open(url):
        click.echo("Could not launch a browser. Open this URL manually:")
        click.echo(url)
        return
    click.echo("Tip: include a screenshot if it's a visual bug.")


if __name__ == "__main__":
    cli()