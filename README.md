# Vaux

A real-time music listening room - join a room, build a queue together, vote on tracks, and listen in sync. Available as both a web app and a terminal CLI.

### 🌐 Live Demo: https://vaux-ten.vercel.app/

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

**Zero-Quota Streaming:** The Node.js server centrally runs `yt-dlp` to dynamically scrape YouTube search results and extract direct audio stream URLs. This completely eliminates the need for YouTube API keys, Google daily quotas, client-side browser cookies, and local `yt-dlp` binaries!

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
| Music source | `yt-dlp` (backend extraction & search), YouTube IFrame API (web), `mpv` (CLI) |
| Hosting      | Vercel (web), Render (server)                                                 |

---

## Installation (CLI)

We highly recommend using [`pipx`](https://pipx.pypa.io/) to install the terminal client globally so it is always available on your drive and not hidden inside a temporary Anaconda environment:

```bash
pipx install vaux-cli
```

Once installed, you can launch it from anywhere:

```bash
vaux-cli                     # Opens the interactive lobby
vaux-cli my-room -u Alice    # Bypasses the lobby to join a room directly
```

## Running locally

### Prerequisites

- Node.js v18+
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
cp .env.example .env   # fill in your values
npm run dev
# running on http://localhost:4000
```

### 3. Start the web app

```bash
cd web
npm install
cp .env.example .env.local   # fill in your values
npm run dev
# running on http://localhost:3000
```

### 4. Start the CLI

```bash
cd cli
python -m venv .venv
.venv\Scripts\activate    # Windows
source .venv/bin/activate # macOS/Linux
pip install -r requirements.txt

# Open the interactive lobby:
python main.py
# Or bypass the lobby to join a room directly:
python main.py my-room --username yourname
```

---

## Environment variables

### server/.env

```
PORT=4000
```

### web/.env.local

```
NEXT_PUBLIC_SERVER_URL=http://localhost:4000
```

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
- [ ] Installable CLI via `pip install vaux-cli`

---

## Why this project

I'm too lazy to switch tabs and need my full screen while coding ... That's it, that's why. 😺
