"""
vaux CLI — terminal client for vaux listening rooms.

Usage:
    python main.py join <room-id> --username <name>
"""
import sys
import os
import shutil
from importlib.metadata import version, PackageNotFoundError

try:
    __version__ = version("vaux-cli")
except PackageNotFoundError:
    __version__ = "dev"

# Add local user vendor folder to PATH just in case
os.environ["PATH"] = os.path.expanduser("~/.vaux/mpv") + os.pathsep + os.environ.get("PATH", "")

import click
from vaux.app import VauxApp, LobbyApp

def ensure_mpv():
    """Checks for mpv and prompts Windows users to auto-download it if missing."""
    mpv_exe = "mpv.exe" if sys.platform == "win32" else "mpv"
    if shutil.which(mpv_exe):
        return
        
    vendor_dir = os.path.expanduser("~/.vaux/mpv")
    mpv_path = os.path.join(vendor_dir, mpv_exe)
    
    if os.path.exists(mpv_path):
        return
        
    if sys.platform == "win32":
        if click.confirm("mpv is required to play audio, but was not found. Download it now?"):
            import urllib.request
            import json
            import zipfile
            import io
            
            click.echo(f"Downloading mpv to {vendor_dir} (this may take a minute)...")
            try:
                api_url = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
                req = urllib.request.Request(api_url, headers={"User-Agent": "vaux-cli"})
                with urllib.request.urlopen(req) as response:
                    data = json.loads(response.read().decode())
                    # Prefer the v3 release, fallback to standard 64-bit
                    zip_url = next((a["browser_download_url"] for a in data.get("assets", []) 
                                    if "mpv-x86_64-v3-" in a["name"] and (a["name"].endswith(".zip") or a["name"].endswith(".7z"))), None)
                    if not zip_url:
                        zip_url = next((a["browser_download_url"] for a in data.get("assets", []) 
                                        if "mpv-x86_64-" in a["name"] and (a["name"].endswith(".zip") or a["name"].endswith(".7z"))), None)
                
                if zip_url:
                    os.makedirs(vendor_dir, exist_ok=True)
                    req = urllib.request.Request(zip_url, headers={"User-Agent": "vaux-cli"})
                    with urllib.request.urlopen(req) as response:
                        archive_data = io.BytesIO(response.read())
                        target_path = os.path.join(vendor_dir, "mpv.exe")
                        
                        if zip_url.endswith(".7z"):
                            try:
                                import py7zr  # type: ignore
                            except ImportError:
                                click.echo("\nError: 'py7zr' is missing but required to extract mpv. Please run: pip install py7zr")
                                return
                            with py7zr.SevenZipFile(archive_data, mode='r') as z:
                                for name in z.getnames():
                                    if name.endswith("mpv.exe"):
                                        file_dict = z.read(targets=[name])
                                        with open(target_path, "wb") as target:
                                            target.write(file_dict[name].getvalue())
                                        break
                        else:
                            with zipfile.ZipFile(archive_data) as z:
                                for file_info in z.infolist():
                                    if file_info.filename.endswith("mpv.exe"):
                                        source = z.open(file_info)
                                        with open(target_path, "wb") as target:
                                            shutil.copyfileobj(source, target)
                                        break
            except Exception as e:
                click.echo(f"Failed to auto-download mpv: {e}")


@click.command(
    epilog="NOTE: vaux requires 'mpv' to play audio. You can download it here: https://mpv.io/installation/"
)
@click.version_option(version=__version__, prog_name="vaux")
@click.argument("room_id", required=False)
@click.option("--username", "-u", help="Your display name.")
@click.option(
    "--server",
    default="https://vaux.onrender.com",
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