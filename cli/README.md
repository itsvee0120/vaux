<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/web/components/ui/vaux_logo.png" alt="Vaux" width="120" />
</p>

# Vaux CLI

A terminal client for [Vaux](https://github.com/itsvee0120/vaux) listening rooms. Listen to YouTube audio in sync with friends directly from your terminal.

Built with [Textual](https://textual.textualize.io/) and powered by `mpv`.

<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/assets/vaux_cli.png" alt="Vaux CLI lobby preview" width="640" />
</p>

## Features

- **Synchronized playback** — everyone hears the same timestamp
- **Shared queue** — search YouTube and add tracks from the terminal
- **Live voting** — vote tracks up or down to re-sort the queue
- **Live chat** — talk with friends alongside the music
- **Host controls** — play, pause, skip, remove tracks, transfer host
- **No YouTube API key** — search and stream URLs come from the Vaux server (with local yt-dlp fallback)

## Requirements

- **mpv** — plays audio. On Windows, the CLI can download a portable build on first run. On Linux/macOS, install via your package manager (`apt install mpv`, `brew install mpv`, etc.).
- **Node.js** (recommended) — modern yt-dlp needs a JS runtime for YouTube extraction. Node is auto-detected when using the local yt-dlp fallback. The hosted server already runs Node.
- **yt-dlp** — included as a package dependency; keep it updated with `pip install -U yt-dlp`.

## Installation

```bash
pipx install vaux-cli
```

Or:

```bash
pip install vaux-cli
```

## Usage

Launch the interactive lobby:

```bash
vaux
```

Join a room directly:

```bash
vaux <room-id> -u <your-name>
```

Point at a local server when developing:

```bash
vaux --server http://localhost:4000
vaux --server http://localhost:4000 my-room -u yourname
```

## Keyboard shortcuts

| Key        | Action                              |
| ---------- | ----------------------------------- |
| `Ctrl+S`   | Focus search                        |
| `Ctrl+T`   | Focus chat                          |
| `Ctrl+O`   | Play / pause (host)                 |
| `Ctrl+N`   | Skip track (host)                   |
| `x` / `Del`| Remove queue item (host, queue focused) |
| `Ctrl+U`   | Vote up selected track              |
| `Ctrl+D`   | Vote down selected track            |
| `Ctrl+G`   | Info (version, links, shortcuts)    |
| `Ctrl+L`   | Listeners & transfer host (host)    |
| `Ctrl+B`   | Report a bug (Google Form / GitHub) |
| `Ctrl+P`   | Command palette (save screenshot, etc.) |
| `-` / `=`  | Volume down / up                    |
| `Ctrl+C`   | Quit                                |

## Host transfer

Transfer host from chat:

```
/host username
```

## Streaming notes

Audio is resolved via the server first, then local yt-dlp fallback. Override `VAUX_API_KEY` only if the server uses a custom `API_KEY`. If playback fails, update yt-dlp and keep Node.js on PATH:

```powershell
pip install -U yt-dlp
yt-dlp --js-runtimes node --remote-components ejs:github "https://youtu.be/VIDEO_ID"
```

If that command works locally, the CLI fallback should work too.

## Reporting bugs

Found something broken? You have three ways to report it:

- **Inside the app** — press `Ctrl+B` from the lobby or any room. An overlay
  opens with two choices:
  - **Google Form** — anonymous, no GitHub account needed.
  - **GitHub Issues** — opens a pre-filled issue with your vaux-cli version,
    Python version, and OS already in the body.
- **From the shell** — `vaux bug` opens the GitHub Issues page in your browser
  with the same pre-filled template.
- **Attaching a screenshot** — press `Ctrl+P` inside vaux to open Textual's
  command palette, then choose **Save screenshot**. vaux writes an SVG of the
  current terminal screen to your working directory; attach it to the form or
  drop it into the GitHub issue. Close the bug-report overlay before capturing
  so the screenshot shows the underlying screen.

## Development

```bash
cd cli
python -m venv .venv
.venv\Scripts\activate        # Windows
source .venv/bin/activate     # macOS/Linux
pip install -e .
python main.py --server http://localhost:4000
```

## Links

- Repository: [github.com/itsvee0120/vaux](https://github.com/itsvee0120/vaux)
- PyPI: [pypi.org/project/vaux-cli](https://pypi.org/project/vaux-cli/)
- Issues: [github.com/itsvee0120/vaux/issues](https://github.com/itsvee0120/vaux/issues)

---

## Why this project

I'm too lazy to switch tabs and need my full screen while coding ... That's it, that's why. 😺

Okay, not entirely.

This project was created because I wanted to learn how to use Socket.IO across a CLI application and a web app. It started as a fun hobby project and a learning exercise, and I decided to publish it so others can play around with it, learn from it, or build their own ideas based on what I've made.

> **Disclaimer:** This is a personal hobby project created for learning and experimentation. It is free, open source, non-commercial, and released under the MIT License. No donations, sponsorships, subscriptions, or other forms of compensation are requested or expected. If you find it useful, that's more than enough.

---

## Author

**Violet Nguyen** — [nviolet0120@gmail.com](mailto:nviolet0120@gmail.com)

## License

MIT — see [LICENSE](../LICENSE).
