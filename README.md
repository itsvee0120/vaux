# Vaux

A real-time music listening room - join a room, build a queue together, vote on tracks, and listen in sync. Available as both a web app and a terminal CLI.

---

## What it does

- Create or join a room via a shareable link (web) or a single command (CLI)
- Search YouTube and add tracks to a shared queue
- Vote tracks up or down — the queue re-sorts in real time for everyone
- Synchronized playback — everyone in the room hears the same track at the same timestamp
- Live chat and emoji reactions alongside the music

---

## Architecture

One backend, two clients. The real-time sync logic is written once and consumed by both the web app and the CLI over the same Socket.io event contract.

```
vaux/
├── server/     Node.js + Express + Socket.io  (shared backend, port 4000)
├── web/        Next.js + React + Tailwind      (browser client, port 3000)
└── cli/        Python + textual                (terminal client)
```

```
┌─────────────────────┐     ┌─────────────────────┐
│   Web client        │     │   CLI client         │
│   Next.js + React   │     │   Python + textual   │
└────────┬────────────┘     └──────────┬───────────┘
         │  Socket.io + REST           │  python-socketio
         └──────────────┬──────────────┘
                        │
           ┌────────────▼────────────┐
           │     Shared backend      │
           │  Node.js + Express      │
           │  Socket.io server       │
           └────────────┬────────────┘
                        │
           ┌────────────▼────────────┐
           │       PostgreSQL        │
           │  users, rooms, queue,   │
           │  votes, chat history    │
           └─────────────────────────┘
```

---

## Socket.io event contract

| Event                  | Direction       | Payload                                                     |
| ---------------------- | --------------- | ----------------------------------------------------------- |
| `room:join`            | Client → Server | `{ roomId, userId, username }`                              |
| `room:joined`          | Server → Client | `{ room, members[], queue[], playbackState, role }`         |
| `room:member_joined`   | Server → Client | `{ userId, username, role }`                                |
| `room:member_left`     | Server → Client | `{ userId }`                                                |
| `queue:add`            | Client → Server | `{ roomId, videoId, title, thumbnailUrl, durationSeconds }` |
| `queue:updated`        | Server → Client | `{ queue[] }` — full queue, sorted by votes                 |
| `queue:vote`           | Client → Server | `{ roomId, queueItemId, value }` — `1` or `-1`              |
| `playback:play_track`  | Client → Server | `{ roomId, itemId }` — host only; starts queue item         |
| `playback:play`        | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                |
| `playback:pause`       | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                |
| `playback:seek`        | Client → Server | `{ roomId, positionSeconds }` — host/DJ only                |
| `playback:state`       | Server → Client | `{ videoId, positionSeconds, isPlaying, updatedAt, ...track }` |
| `playback:ended`       | Client → Server | `{ roomId }` — host only; auto-plays next queue item          |
| `playback:track_ended` | Server → Client | `{ nextItem \| null }`                                      |
| `chat:send`            | Client → Server | `{ roomId, userId, username, text }`                        |
| `chat:message`         | Server → Client | `{ userId, username, text, timestamp }`                     |
| `reaction:send`        | Client → Server | `{ roomId, emoji }`                                         |
| `reaction:broadcast`   | Server → Client | `{ userId, emoji }`                                         |
|                        |

### Sync formula

Both clients implement this identically on every `playback:state` event:

```js
currentPosition = state.positionSeconds + (Date.now() - state.updatedAt) / 1000;
// seek player to currentPosition — corrects drift automatically
```

---

## Tech stack

| Layer        | Technology                                                         |
| ------------ | ------------------------------------------------------------------ |
| Web frontend | Next.js 16, React, Tailwind CSS, TypeScript                        |
| CLI frontend | Python 3.12, textual, python-socketio                              |
| Backend      | Node.js, Express, Socket.io                                        |
| Database     | PostgreSQL                                                         |
| Music source | YouTube Data API v3 (search), YouTube IFrame Player API (playback) |
| Hosting      | Vercel (web), Render (server)                                      |

---

## Running locally

### Prerequisites

- Node.js v18+
- Python 3.11+
- PostgreSQL

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
python main.py join my-room --username yourname
```

---

## Environment variables

### server/.env

```
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/vaux
YOUTUBE_API_KEY=your_youtube_data_api_v3_key
```

### web/.env.local

```
NEXT_PUBLIC_SERVER_URL=http://localhost:4000
```

---

## Database schema

| Table            | Purpose                               |
| ---------------- | ------------------------------------- |
| `users`          | Registered users                      |
| `rooms`          | Jam rooms with invite codes           |
| `room_members`   | Who is in which room, with role       |
| `queue_items`    | Songs in each room's queue            |
| `votes`          | Up/down votes per user per queue item |
| `playback_state` | Current track + position per room     |

---

## Roles

| Role     | Can do                                              |
| -------- | --------------------------------------------------- |
| Host     | Everything — play, pause, seek, skip, remove tracks |
| DJ       | Add tracks, vote, control playback                  |
| Listener | Add tracks, vote, chat                              |

---

## Roadmap

- Real-time rooms and chat
- YouTube search and shared queue
- Synchronized playback
- Voting system
- Roles (Host / DJ / Listener)
- Emoji reactions
- Song history
- Public room discovery
- AI playlist seeding from room vibe
- CLI installable via `pip install vaux-cli`

---

## Why this project

I'm too lazy to switch tabs and need my full screen while coding ... That's it, that's why. 😺
