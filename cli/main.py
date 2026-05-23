"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    python main.py join <room-id> --username <name>
"""
import asyncio
import sys
import os

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
# Ensure python-mpv can find mpv-1.dll or mpv-2.dll if it's placed in this folder
os.environ["PATH"] = os.path.dirname(os.path.abspath(__file__)) + os.pathsep + os.environ.get("PATH", "")

import click
from vaux.app import VauxApp


@click.group()
def cli():
    """vaux — listen together, in sync."""
    pass


@cli.command()
@click.argument("room_id")
@click.option("--username", "-u", required=True, help="Your display name.")
@click.option(
    "--server",
    default="http://localhost:4000",
    envvar="VAUX_SERVER_URL",
    show_default=True,
    help="vaux server URL.",
)
def join(room_id: str, username: str, server: str):
    """Join a vaux room and listen together."""
    app = VauxApp(room_id=room_id, username=username, server_url=server)
    app.run()


if __name__ == "__main__":
    cli()