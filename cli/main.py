"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    python main.py join <room-id> --username <name>
"""
import asyncio
import sys
import os
import shutil

# Ensure python-mpv can find mpv-1.dll or mpv-2.dll if it's placed in this folder
os.environ["PATH"] = os.path.dirname(os.path.abspath(__file__)) + os.pathsep + os.environ.get("PATH", "")

import click
from vaux.app import VauxApp, LobbyApp

def ensure_mpv():
    """Checks for mpv and prompts Windows users to auto-download it if missing."""
    mpv_exe = "mpv.exe" if sys.platform == "win32" else "mpv"
    if shutil.which(mpv_exe):
        return
        
    base_dir = os.path.dirname(os.path.abspath(__file__))
    vendor_dir = os.path.join(base_dir, "vendor", "mpv")
    mpv_path = os.path.join(vendor_dir, mpv_exe)
    
    if os.path.exists(mpv_path):
        return
        
    if sys.platform == "win32":
        if click.confirm("mpv is required to play audio, but was not found. Download it now?"):
            import urllib.request
            import json
            import zipfile
            import io
            
            click.echo("Downloading mpv for Windows (this may take a minute)...")
            try:
                api_url = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
                req = urllib.request.Request(api_url, headers={"User-Agent": "vaux-cli"})
                with urllib.request.urlopen(req) as response:
                    data = json.loads(response.read().decode())
                    zip_url = next((a["browser_download_url"] for a in data.get("assets", []) 
                                    if a["name"].startswith("mpv-x86_64-") and a["name"].endswith(".zip")), None)
                
                if zip_url:
                    os.makedirs(vendor_dir, exist_ok=True)
                    req = urllib.request.Request(zip_url, headers={"User-Agent": "vaux-cli"})
                    with urllib.request.urlopen(req) as response:
                        with zipfile.ZipFile(io.BytesIO(response.read())) as z:
                            for file_info in z.infolist():
                                if file_info.filename.endswith("mpv.exe"):
                                    source = z.open(file_info)
                                    target_path = os.path.join(vendor_dir, "mpv.exe")
                                    with open(target_path, "wb") as target:
                                        shutil.copyfileobj(source, target)
                                    break
            except Exception as e:
                click.echo(f"Failed to auto-download mpv: {e}")


@click.command()
@click.argument("room_id", required=False)
@click.option("--username", "-u", help="Your display name.")
@click.option(
    "--server",
    default="http://localhost:4000",
    envvar="VAUX_SERVER_URL",
    show_default=True,
    help="vaux server URL.",
)
def cli(room_id: str | None, username: str | None, server: str):
    """vaux — listen together, in sync. Run without arguments to open the interactive lobby."""
    ensure_mpv()

    if not room_id or not username:
        lobby = LobbyApp(server_url=server)
        lobby.run()

        if lobby.result is None:
            return

        room_id, username = lobby.result

    app = VauxApp(room_id=room_id, username=username, server_url=server)
    app.run()


if __name__ == "__main__":
    cli()