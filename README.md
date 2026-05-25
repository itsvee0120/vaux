<p align="center">
  <img src="https://raw.githubusercontent.com/itsvee0120/vaux/main/web/components/ui/vaux_logo.png" alt="Vaux" width="120" />
</p>

# Vaux

A real-time music listening room - join a room, build a queue together, vote on tracks, and listen in sync. Available as both a web app and a terminal CLI.
### Vaux on web: https://vaux-ten.vercel.app/ 
<img width="1851" height="841" alt="image" src="https://github.com/user-attachments/assets/ad7438f3-6c78-4993-b205-1c802eeda15c" />

### Vaux on CLI - 🐍 Latest Version on Pypi: https://pypi.org/project/vaux-cli/


https://github.com/user-attachments/assets/ae3808a2-98e7-4c24-af91-6adc98b5a966


---

## What it does

- Create or join a room via a shareable link (web) or a single command (CLI)
- Search YouTube and add tracks to a shared queue
- Vote tracks up or down — the queue re-sorts in real time for everyone
- Synchronized playback — everyone in the room hears the same track at the same timestamp
- Host controls: Play, pause, seek, skip tracks, and transfer host privileges
- Live chat and emoji reactions alongside the music
- Local volume controls for all users (Web and CLI)

---

## Architecture

One backend, two clients. The real-time sync logic is written once and consumed by both the web app and the CLI over the same Socket.io event contract.

**Zero-Quota Streaming:** The Node.js server runs `yt-dlp` with Node as a JS runtime to search YouTube and extract direct audio stream URLs — no YouTube API keys or Google quotas. The web client uses the YouTube IFrame player; the CLI uses `mpv` with stream URLs from the server (local yt-dlp fallback when needed).

```
vaux/
├── server/     Node.js + Express + Socket.io  (shared backend, port 4000)
├── web/        Next.js + React + Tailwind      (browser client, port 3000)
└── cli/        Python + textual                (terminal client)
```

```
                ┌─────────────────────┐
                │     YouTube         │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │   yt-dlp (Server)   │
                │ Search              │
                │ Metadata            │
                │ Stream Extraction   │
                └──────────┬──────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │                                   │
         ▼                                   ▼
┌─────────────────┐               ┌─────────────────┐
│   Web Client    │               │   CLI Client    │
│ IFrame Player   │               │ mpv Player      │
└─────────────────┘               └─────────────────┘
```

---

## Socket.io event contract

| Event                  | Direction       | Payload                                                        |
| ---------------------- | --------------- | -------------------------------------------------------------- |
| `room:join`            | Client → Server | `{ roomId, userId, username }`                                 |
| `room:joined`          | Server → Client | `{ room, members[], queue[], playbackState, role }`            |
| `room:member_joined`   | Server → Client | `{ userId, username, role }`                                   |
| `room:member_left`     | Server → Client | `{ userId }`                                                   |
| `queue:add`            | Client → Server | `{ roomId, videoId, title, thumbnailUrl, durationSeconds }`    |
| `queue:remove`         | Client → Server | `{ roomId, itemId }` — host only                               |
| `queue:updated`        | Server → Client | `{ queue[] }` — full queue, sorted by votes                    |
| `queue:vote`           | Client → Server | `{ roomId, queueItemId, value }` — `1` or `-1`                 |
| `playback:play_track`  | Client → Server | `{ roomId, itemId }` — host only; starts queue item            |
| `playback:play`        | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                   |
| `playback:pause`       | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                   |
| `playback:seek`        | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                   |
| `playback:state`       | Server → Client | `{ videoId, positionSeconds, isPlaying, updatedAt, ...track }` |
| `playback:ended`       | Client → Server | `{ roomId }` — host only; auto-plays next queue item           |
| `playback:track_ended` | Server → Client | `{ nextItem \| null }`                                         |
| `chat:send`            | Client → Server | `{ roomId, userId, username, text }`                           |
| `chat:message`         | Server → Client | `{ userId, username, text, timestamp }`                        |
| `reaction:send`        | Client → Server | `{ roomId, emoji }`                                            |

### Sync formula

Both clients implement this identically on every `playback:state` event:

```js
currentPosition = state.positionSeconds + (Date.now() - state.updatedAt) / 1000;
// seek player to currentPosition — corrects drift automatically
```

---

## Tech stack

| Layer        | Technology                                                                    |
| ------------ | ----------------------------------------------------------------------------- |
| Web frontend | Next.js 16, React, Tailwind CSS, TypeScript                                   |
| CLI frontend | Python 3.12, textual, python-socketio                                         |
| Backend      | Node.js, Express, Socket.io                                                   |
| Database     | In-memory (Currently)                                                         |
| Music source | `yt-dlp` + Node.js (server search & stream extraction), YouTube IFrame API (web), `mpv` (CLI) |
| Hosting      | Vercel (web), Render (server)                                                 |

---

## Installation (CLI)

Install from PyPI: [pypi.org/project/vaux-cli](https://pypi.org/project/vaux-cli/)

```bash
pipx install vaux-cli
```

or

```bash
pip install vaux-cli
```

**Requirements:** `mpv` for audio playback (auto-downloaded on Windows). For local yt-dlp fallback, keep yt-dlp updated and have Node.js on your PATH.

Once installed, launch from anywhere:

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

| Key         | Action                              |
| ----------- | ----------------------------------- |
| `Ctrl+S`    | Focus Search                        |
| `Ctrl+T`    | Focus Chat                          |
| `Ctrl+O`    | Play / Pause (Host only)            |
| `Ctrl+N`    | Skip Track (Host only)              |
| `x` / `Del` | Remove queue item (Host, queue focused) |
| `Ctrl+U`    | Vote Up selected track              |
| `Ctrl+D`    | Vote Down selected track            |
| `Ctrl+G`    | Info                                |
| `Ctrl+L`    | Listeners & transfer host (Host)    |
| `-` / `=`   | Volume Down / Up                    |
| `Ctrl+C`    | Quit                                |

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

## Running locally

### Prerequisites

- Node.js v18+ (required for yt-dlp YouTube extraction on the server)
- Python 3.11+

### 1. Clone the repo

```bash
git clone https://github.com/itsvee0120/vaux.git
cd vaux
```

### 2. Start the server

```bash
cd server
npm install
cp .env.example .env   # optional — defaults work out of the box
npm run dev
# running on http://localhost:4000
```

### 3. Start the web app

```bash
cd web
npm install
cp .env.local.example .env.local   # optional
npm run dev
# running on http://localhost:3000
```

### 4. Start the CLI locally

The CLI defaults to the hosted server (`https://vaux.onrender.com`). When you run the **local** server and web app, you must point the CLI at `http://localhost:4000` or it will join a different backend — chat, queue, and playback will not sync with the browser.

```bash
cd cli
python -m venv .venv
.venv\Scripts\activate    # Windows
source .venv/bin/activate # macOS/Linux
pip install -e .

# Open the interactive lobby (local server):
python main.py --server http://localhost:4000

# Or join a room directly:
python main.py --server http://localhost:4000 my-room --username yourname
```

If you installed `vaux-cli` from PyPI instead of running from source, use the same flag:

```bash
vaux --server http://localhost:4000
vaux --server http://localhost:4000 my-room -u yourname
```

---

## Environment variables

All clients share a built-in **public dev gate** key for `/youtube` routes (`vaux-02187xdsx-4335`). It is not a secret — it only filters casual bot traffic. Override it in production if desired.

### server/.env

```
PORT=4000
# API_KEY=vaux-02187xdsx-4335   # optional override
```

### web/.env.local

```
NEXT_PUBLIC_SERVER_URL=http://localhost:4000
# NEXT_PUBLIC_API_KEY=...         # optional override
```

### CLI

```
# VAUX_API_KEY=...                # optional override
--server http://localhost:4000
```

Pass `--server` when running against a local backend:

```
--server http://localhost:4000

example: python main.py --server http://localhost:4000
```

Omit `--server` only when you intend to use the public hosted server.

---

## Roles

| Role     | Can do                                              |
| -------- | --------------------------------------------------- |
| Host     | Everything — play, pause, seek, skip, remove tracks |
| Listener | Add tracks, vote, chat                              |

---

## Roadmap

(X = done, - = in progress)

- [x] Real-time rooms
- [x] Shared queue
- [x] Live voting
- [x] Synchronized playback
- [x] Host controls
- [x] Chat
- [ ] Emoji reactions
- [ ] Song history
- [ ] Public room discovery
- [ ] AI playlist seeding
- [ ] Persistent PostgreSQL storage
- [x] Installable CLI via `pip install vaux-cli`

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

This project is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Violet Nguyen
