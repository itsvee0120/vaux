"""Find mpv on disk and bootstrap it on Windows when missing."""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys

import click
import httpx

VENDOR_DIR = os.path.expanduser("~/.vaux/mpv")
STAGING_DIR = os.path.expanduser("~/.vaux/.mpv-install")
SEVEN_Z_DIR = os.path.expanduser("~/.vaux/7z")
SEVEN_Z_EXE = os.path.join(SEVEN_Z_DIR, "7z.exe")
# Standalone installer; bundles BCJ2 and other filters mpv archives need.
SEVEN_Z_INSTALLER_URL = "https://www.7-zip.org/a/7z2409-x64.exe"
CONFIG_PATH = os.path.expanduser("~/.vaux/config.json")
MPV_RELEASES_API = "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest"
_PORTABLE_ASSET = re.compile(r"^mpv-(x86_64|aarch64)-\d{8}-git-[0-9a-f]+\.7z$")
_GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "vaux-cli",
}


def _exe_name() -> str:
    return "mpv.exe" if sys.platform == "win32" else "mpv"


def _load_cached() -> str | None:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            path = json.load(f).get("mpv_path")
        if path and os.path.isfile(path):
            return path
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    return None


def _save_cached(path: str) -> None:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    data: dict = {}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    data["mpv_path"] = path
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)


def register_mpv(path: str) -> None:
    _save_cached(path)
    bin_dir = os.path.dirname(os.path.abspath(path))
    path_env = os.environ.get("PATH", "")
    if bin_dir.casefold() not in path_env.casefold():
        os.environ["PATH"] = bin_dir + os.pathsep + path_env
    os.environ["VAUX_MPV"] = path


def _registry_paths() -> list[str]:
    if sys.platform != "win32":
        return []
    import winreg

    exe = _exe_name()
    out: list[str] = []
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, subkey in roots:
        try:
            with winreg.OpenKey(hive, subkey) as root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    try:
                        with winreg.OpenKey(root, winreg.EnumKey(root, i)) as key:
                            try:
                                name = str(winreg.QueryValueEx(key, "DisplayName")[0])
                            except OSError:
                                continue
                            if "mpv" not in name.lower():
                                continue
                            try:
                                loc = winreg.QueryValueEx(key, "InstallLocation")[0]
                            except OSError:
                                loc = ""
                            if loc:
                                out.append(os.path.join(loc, exe))
                                out.append(os.path.join(loc, "mpv", exe))
                    except OSError:
                        continue
        except OSError:
            continue
    return out


def _walk_mpv(root: str, max_depth: int) -> str | None:
    exe = _exe_name()
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        return None
    for dirpath, dirnames, filenames in os.walk(root):
        if dirpath[len(root) :].count(os.sep) > max_depth:
            dirnames.clear()
            continue
        if exe in filenames:
            return os.path.join(dirpath, exe)
    return None


def _candidate_paths(*, deep: bool) -> list[str]:
    exe = _exe_name()
    local = os.environ.get("LOCALAPPDATA", "")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pfx86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")

    paths: list[str] = [
        os.path.join(VENDOR_DIR, exe),
        os.path.join(local, "Microsoft", "WinGet", "Links", exe),
    ]
    for base in (pf, pfx86, os.path.join(local, "Programs")):
        paths.append(os.path.join(base, "mpv", exe))
        if deep and os.path.isdir(base):
            hit = _walk_mpv(base, max_depth=3)
            if hit:
                paths.append(hit)

    paths.extend(_registry_paths())

    winget_pkgs = os.path.join(local, "Microsoft", "WinGet", "Packages")
    if os.path.isdir(winget_pkgs):
        hit = _walk_mpv(winget_pkgs, max_depth=6 if deep else 4)
        if hit:
            paths.append(hit)

    seen: set[str] = set()
    unique: list[str] = []
    for p in paths:
        key = os.path.normcase(p)
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def find_mpv(*, deep: bool = False) -> str | None:
    cached = _load_cached()
    if cached:
        return cached

    exe = _exe_name()
    found = shutil.which(exe) or shutil.which("mpv")
    if found:
        return found

    for path in _candidate_paths(deep=deep):
        if os.path.isfile(path):
            return path

    if sys.platform == "win32" and not deep:
        return find_mpv(deep=True)
    return None


def _windows_mpv_arch() -> str:
    machine = (os.environ.get("PROCESSOR_ARCHITEW6432") or platform.machine()).upper()
    if machine in ("ARM64", "AARCH64"):
        return "aarch64"
    if machine in ("AMD64", "X86_64"):
        return "x86_64"
    raise RuntimeError(f"unsupported Windows CPU architecture: {machine}")


def _pick_portable_asset(assets: list[dict]) -> dict:
    arch = _windows_mpv_arch()
    matches = [
        a for a in assets
        if _PORTABLE_ASSET.match(a.get("name", ""))
        and a["name"].startswith(f"mpv-{arch}-")
    ]
    if not matches:
        raise RuntimeError(f"no portable mpv build found for {arch}")
    return matches[0]


def _remove_path(path: str) -> None:
    if not os.path.exists(path):
        return
    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def _remove_path_quiet(path: str) -> None:
    try:
        _remove_path(path)
    except OSError:
        pass


def _clear_staging() -> None:
    _remove_path_quiet(STAGING_DIR)


def _install_vendor_tree(bin_dir: str) -> str:
    exe = _exe_name()
    dest = os.path.join(VENDOR_DIR, exe)
    if os.path.isdir(VENDOR_DIR):
        shutil.rmtree(VENDOR_DIR, ignore_errors=True)
    os.makedirs(VENDOR_DIR, exist_ok=True)
    for name in os.listdir(bin_dir):
        src = os.path.join(bin_dir, name)
        dst = os.path.join(VENDOR_DIR, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    if not os.path.isfile(dest):
        raise RuntimeError("mpv.exe missing after install")
    return dest


def _download_to_path(client: httpx.Client, url: str, dest: str) -> None:
    """Write download to dest; all handles closed before return."""
    part = dest + ".part"
    _remove_path_quiet(part)
    try:
        with client.stream("GET", url, timeout=httpx.Timeout(60.0, read=600.0)) as resp:
            resp.raise_for_status()
            with open(part, "wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)
                f.flush()
                os.fsync(f.fileno())
    except Exception:
        _remove_path_quiet(part)
        raise
    _remove_path_quiet(dest)
    os.replace(part, dest)


def _find_system_7z() -> str | None:
    for name in ("7z", "7z.exe", "7zr", "7zr.exe"):
        found = shutil.which(name)
        if found:
            return found
    for path in (
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "7-Zip", "7z.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "7-Zip", "7z.exe"),
    ):
        if os.path.isfile(path):
            return path
    return None


def _ensure_7z(client: httpx.Client) -> str:
    if os.path.isfile(SEVEN_Z_EXE):
        return SEVEN_Z_EXE

    found = _find_system_7z()
    if found:
        return found

    os.makedirs(SEVEN_Z_DIR, exist_ok=True)
    installer = os.path.join(STAGING_DIR, "7z-setup.exe")
    click.echo("Downloading 7-Zip (one-time, ~1.5 MB)...")
    _download_to_path(client, SEVEN_Z_INSTALLER_URL, installer)

    click.echo("Installing 7-Zip extractor...")
    subprocess.run(
        [installer, "/S", f"/D={SEVEN_Z_DIR}"],
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    _remove_path_quiet(installer)

    if not os.path.isfile(SEVEN_Z_EXE):
        raise RuntimeError("7-Zip install failed (7z.exe not found)")
    return SEVEN_Z_EXE


def _extract_7z(archive_path: str, extract_dir: str, seven_z: str) -> None:
    os.makedirs(extract_dir, exist_ok=True)
    out = extract_dir.rstrip("\\/") + os.sep
    result = subprocess.run(
        [seven_z, "x", archive_path, f"-o{out}", "-y"],
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail or f"7-Zip exited with code {result.returncode}")


def _download_portable_mpv() -> str:
    _clear_staging()
    os.makedirs(STAGING_DIR, exist_ok=True)

    with httpx.Client(headers=_GITHUB_HEADERS, follow_redirects=True, timeout=60) as client:
        seven_z = _ensure_7z(client)

        release = client.get(MPV_RELEASES_API).json()
        if "assets" not in release:
            message = release.get("message", "unknown GitHub API error")
            raise RuntimeError(f"could not query mpv releases: {message}")

        asset = _pick_portable_asset(release["assets"])
        name = asset["name"]
        archive_path = os.path.join(STAGING_DIR, name)
        extract_dir = os.path.join(STAGING_DIR, "extracted")

        click.echo(f"Downloading {name} (~30 MB)...")
        _download_to_path(client, asset["browser_download_url"], archive_path)

    click.echo("Extracting...")
    _extract_7z(archive_path, extract_dir, seven_z)

    _remove_path(archive_path)

    found = _walk_mpv(extract_dir, max_depth=5)
    if not found:
        raise RuntimeError("mpv.exe not found inside downloaded archive")

    dest = _install_vendor_tree(os.path.dirname(found))
    _remove_path_quiet(extract_dir)
    _remove_path_quiet(STAGING_DIR)
    return dest


def ensure_mpv() -> str:
    path = find_mpv()
    if path:
        register_mpv(path)
        return path

    if sys.platform != "win32":
        click.echo("mpv required: https://mpv.io/installation/")
        sys.exit(1)

    if not click.confirm("mpv not found. Download a portable build automatically?"):
        sys.exit(1)

    try:
        path = _download_portable_mpv()
    except Exception as exc:
        click.echo(f"\n[!] Could not install mpv: {exc}")
        click.echo("Install manually: https://mpv.io/installation/\n")
        sys.exit(1)

    register_mpv(path)
    click.echo(f"mpv installed to {path}")
    return path
