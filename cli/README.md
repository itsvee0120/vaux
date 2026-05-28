<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/web/components/ui/vaux_logo.png" alt="Vaux" width="120" />
</p>

# Vaux CLI

A terminal client for [Vaux](https://github.com/itsvee0120/vaux) listening rooms. Listen to YouTube audio in sync with friends directly from your terminal.

Built with [Textual](https://textual.textualize.io/) and powered by `mpv`.

<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/assets/vaux_lobby_cli.png" alt="Vaux CLI lobby preview" width="640" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/assets/vaux_room.png" alt="Vaux CLI room preview" width="640" />
</p>

---

## Features

- **Synchronized playback** — everyone hears the same timestamp
- **Shared queue** — search YouTube and add tracks from the terminal
- **Live voting** — vote tracks up or down to re-sort the queue
- **Live chat** — talk with friends alongside the music
- **Private rooms** — invite-only with end-to-end encrypted chat (XSalsa20-Poly1305, Argon2id key derivation). Room burns when the host leaves.
- **Host controls** — play, pause, skip, remove tracks, transfer host
- **No YouTube API key** — search and stream URLs come from the Vaux server (with local yt-dlp fallback)
- **Faster track starts** — background stream preloading + cache-aware resolution paths

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

Upgrade to latest release

```bash
pip install --upgrade vaux-cli
```

## Usage

Launch the interactive lobby:

```bash
vaux
```

Join a public room directly:

```bash
vaux <room-id> -u <your-name>
```

Join a private room from an invite link or 22-character code:

```bash
vaux "https://vaux.app/#<22-char-code>" -u <your-name>
vaux <22-char-code> -u <your-name>
```

Or paste the invite from the lobby's `🔒 private → paste invite` tab.

Point at a local server when developing:

```bash
vaux --server http://localhost:4000
vaux --server http://localhost:4000 my-room -u yourname
```

## Keyboard shortcuts

### In a room

| Key         | Action                                  |
| ----------- | --------------------------------------- |
| `Ctrl+S`    | Focus search                            |
| `Ctrl+R`    | Clear search results                    |
| `Ctrl+T`    | Focus chat                              |
| `↑` / `↓`   | Chat history (chat input focused)       |
| `Ctrl+O`    | Play / pause (host)                     |
| `Ctrl+N`    | Skip track (host)                       |
| `x` / `Del` | Remove queue item (host, queue focused) |
| `Ctrl+U`    | Vote up selected track                  |
| `Ctrl+D`    | Vote down selected track                |
| `-` / `=`   | Volume down / up                        |
| `m`         | Mute / unmute                           |
| `Ctrl+K`    | Copy room name (or private invite code) |
| `Ctrl+L`    | Listeners & transfer host (host)        |
| `Ctrl+G`    | Info (version, links, shortcuts)        |
| `Ctrl+B`    | Report a bug (Google Form / GitHub)     |
| `Ctrl+P`    | Command palette (save screenshot, etc.) |
| `Ctrl+C`    | Quit                                    |

Type `/host <username>` in chat to transfer host to another listener.

### Private rooms

- Chat messages and member names are **end-to-end encrypted** with a key derived locally from the invite code (Argon2id). The server only sees ciphertext.
- The **room ID, queue, and playback events are NOT encrypted** — only chat. Don't share private-room codes through untrusted channels.
- The invite code stays in memory only. Closing the CLI loses it. Share before joining.
- When the **host quits**, the room is destroyed immediately. Other members are disconnected.
- Wrong codes lock the room for 60 s after 10 failed attempts.

### Lobby

| Key      | Action                                  |
| -------- | --------------------------------------- |
| `Tab`    | Next field                              |
| `Ctrl+G` | Info (version, links, shortcuts)        |
| `Ctrl+B` | Report a bug (Google Form / GitHub)     |
| `Ctrl+P` | Command palette (save screenshot, etc.) |
| `Ctrl+C` | Quit                                    |

### Modal overlays

| Key   | Action                                         |
| ----- | ---------------------------------------------- |
| `Esc` | Close current overlay (Info / Bug / Listeners) |

## Streaming notes

Audio stream URLs are resolved through a low-latency pipeline:

- Server attempts yt-dlp extraction with client-chain fallbacks.
- Server caches stream URLs for a short TTL and pre-resolves on `queue:add`.
- CLI races server and local yt-dlp in parallel, then uses the first success.
- CLI preloads upcoming tracks and keeps an in-memory per-session stream cache.

During playback startup, the system log shows:

- `⚡ stream source: cache (local)`
- `⚡ stream source: cache (server)`
- `⚡ stream source: server live`
- `⚡ stream source: local yt-dlp`

Override `VAUX_API_KEY` only if the server uses a custom `API_KEY`. If playback fails, update yt-dlp and keep Node.js on PATH:

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
