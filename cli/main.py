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

import asyncio

import click
from vaux.app import VauxApp, LobbyApp
from vaux.crypto import (
    auth_proof_to_b64,
    derive_room_material,
    encrypt_chat,
    is_well_formed_password,
    parse_invite,
)
from vaux.socket_client import probe_join
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
    # quick join (one-shot — falls through to lobby loop on failure so the
    # user sees the error there instead of being trapped inside an empty room).
    # ------------------------
    quick_error: str | None = None
    initial_invite: str | None = invite_password

    if room_id and username and not invite_password:
        # Probe BEFORE launching VauxApp so a rejected join (room doesn't
        # exist, full, etc.) never flashes the room UI — the error lands
        # at the terminal level and we drop into the lobby.
        click.echo("Connecting…", err=False)
        err = asyncio.run(probe_join(server, room_id, username, is_private=False))
        if err:
            quick_error = err
        else:
            VauxApp(
                room_id=room_id, username=username, server_url=server,
            ).run()
            return

    elif invite_password and username:
        click.echo("Deriving keys (argon2id)…", err=False)
        material = derive_room_material(invite_password)
        cipher = encrypt_chat(material.chat_key, username)
        click.echo("Connecting…", err=False)
        err = asyncio.run(
            probe_join(
                server,
                material.room_id,
                cipher,
                is_private=True,
                auth_proof_b64=auth_proof_to_b64(material.auth_proof),
                create=False,  # quick-join via URL never creates
            )
        )
        if err:
            quick_error = err
        else:
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
    # lobby loop — re-opens on any failed join so the user can correct the
    # mistake (wrong room id, wrong invite code) without restarting vaux.
    # ------------------------
    if room_id and not username and not quick_error:
        click.echo("Pass -u <name> to quick-join this room directly.")

    next_error: str | None = quick_error
    next_invite: str | None = initial_invite

    while True:
        lobby = LobbyApp(
            server_url=server,
            initial_invite=next_invite,
            initial_error=next_error,
        )
        lobby.run()

        if lobby.result is None:
            return

        sel = lobby.result
        app = VauxApp(
            room_id=sel.room_id,
            username=sel.username,
            server_url=server,
            is_private=sel.is_private,
            auth_proof_b64=sel.auth_proof_b64,
            chat_key=sel.chat_key,
            password=sel.password,
            create_private=sel.create,
        )
        app.run()

        if not app.join_error:
            return

        # Preserve the password the user just tried so they don't have to
        # paste it again — they may have just typed their name wrong.
        next_error = app.join_error
        next_invite = sel.password if sel.is_private else None

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