# Vaux CLI

A terminal client for vaux listening rooms. Listen to YouTube audio in perfectly synchronized harmony with your friends directly from your terminal.

Built with [Textual](https://textual.textualize.io/) and powered by `mpv`.

## Features

- **Synchronized Playback:** Everyone in the room hears the exact same timestamp.
- **Shared Queue:** Search YouTube directly from the terminal and add tracks.
- **Live Voting:** Vote tracks up (`ctrl+u`) or down (`ctrl+d`) to re-sort the queue.
- **Live Chat:** Talk with friends right next to the music.
- **Host Controls:** Pause, play, skip, and manage the room.
- **Zero-Quota:** No YouTube API keys required. Audio streams are dynamically extracted by the Vaux server.

## Installation

```bash
pip install vaux-cli
```

*Note: The CLI requires `mpv` to play audio. If you are on Windows, the app will automatically offer to download a portable version of `mpv` for you on first run! Linux/macOS users should install `mpv` via their package manager (e.g., `apt install mpv` or `brew install mpv`).*

## Usage

Launch the interactive lobby:

```bash
vaux
```

Or bypass the lobby to join a room directly:

```bash
vaux <room-id> -u <your-name>
```

## Keyboard Shortcuts


| Key       | Action                   |
| --------- | ------------------------ |
| `Ctrl+S`  | Focus Search             |
| `Ctrl+T`  | Focus Chat               |
| `Ctrl+O`  | Play / Pause (Host only) |
| `Ctrl+N`  | Skip Track (Host only)   |
| `Ctrl+U`  | Vote Up selected track   |
| `Ctrl+D`  | Vote Down selected track |
| `-` / `=` | Volume Down / Up         |
| `Ctrl+C`  | Quit                     |


---

### Host

The room host can:

- Play tracks
- Pause playback
- Resume playback
- Skip tracks
- Transfer host privileges
- Control room playback state

### Listener

Listeners can:

- Search tracks
- Add songs to the queue
- Vote on songs
- Participate in chat

## Host Transfer

Hosts can transfer control to another user directly from chat:

```
/host username
```

Example:

```
/host john
```



---

## Project Links

Repository: [https://github.com/itsvee0120/vaux](https://github.com/itsvee0120/vaux)
Issues: [https://github.com/itsvee0120/vaux/issues](https://github.com/itsvee0120/vaux/issues)

---

## Contact:

[https://itsvee0120.github.io/violet-website/](https://itsvee0120.github.io/violet-website/)