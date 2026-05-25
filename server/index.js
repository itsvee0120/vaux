require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");

const YTDlpWrap = require("yt-dlp-wrap").default || require("yt-dlp-wrap");
let ytdlp = new YTDlpWrap();

/** Modern YouTube extraction needs a JS runtime and EJS challenge scripts. */
function ytdlpBaseArgs() {
  return ["--js-runtimes", "node", "--remote-components", "ejs:github"];
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Vaux API is running!");
});

// ─────────────────────────────
// HEALTH
// ─────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", project: "vaux" });
});

// ─────────────────────────────
// API PROTECTION MIDDLEWARE
// ─────────────────────────────
// Public dev gate for /youtube routes — not a secret; blocks casual bot scans.
const DEFAULT_API_KEY = "vaux-02187xdsx-4335";
const API_KEY = process.env.API_KEY || DEFAULT_API_KEY;

app.use("/youtube", (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Per-IP rate limits on the yt-dlp endpoints. Each call spawns a yt-dlp
// process (1-10s, network-heavy), so unbounded requests are a trivial DoS
// vector. Limits sized for normal interactive use with headroom for fast
// typers; well below what scrapers/scanners typically push.
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded — slow down" },
});

const streamLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded — slow down" },
});

// ─────────────────────────────
// YOUTUBE SEARCH
// ─────────────────────────────
app.get("/youtube/search", searchLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "query required" });

  const limit = Math.min(parseInt(req.query.limit) || 20, 30);

  try {
    const stdout = await ytdlp.execPromise([
      `ytsearch${limit}:${q}`,
      ...ytdlpBaseArgs(),
      "--dump-single-json",
      "--flat-playlist",
      "--no-warnings",
    ]);

    const data = JSON.parse(stdout);
    const entries = data.entries || [];

    const results = entries.map((item) => ({
      videoId: item.id,
      title: item.title,
      channel: item.uploader || item.channel || "YouTube",
      thumbnail:
        item.thumbnails?.length > 0
          ? item.thumbnails[0].url
          : `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
      duration: item.duration ?? 0,
    }));

    res.json({ results });
  } catch (err) {
    console.error("[youtube] search error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

async function resolveStreamUrl(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const stdout = await ytdlp.execPromise([
      watchUrl,
      ...ytdlpBaseArgs(),
      "--get-url",
      "--no-warnings",
      "-f",
      "bestaudio/best",
    ]);
    return stdout.trim().split(/\r?\n/).find(Boolean) || null;
  } catch (err) {
    console.warn("[youtube] stream extraction failed:", err.message || err);
    return null;
  }
}

app.get("/youtube/stream", streamLimiter, async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "videoId required" });

  try {
    const url = await resolveStreamUrl(videoId);
    if (!url) {
      return res.status(500).json({ error: "could not resolve stream" });
    }
    res.json({ url });
  } catch (err) {
    console.error("[youtube] stream error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ─────────────────────────────
// IN-MEMORY ROOMS
// ─────────────────────────────
const rooms = {};

function emptyPlaybackState() {
  return {
    videoId: null,
    title: null,
    channel: null,
    thumbnail: null,
    trackId: null,
    duration: 0,
    positionSeconds: 0,
    isPlaying: false,
    updatedAt: Date.now(),
  };
}

// Memory bounds. In-memory state grows with rooms/members/queues — without
// caps a single attacker can OOM the server by spamming joins or queue adds.
const MAX_ROOMS = 200;
const MAX_MEMBERS_PER_ROOM = 50;
const MAX_QUEUE_LENGTH = 100;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000; // delete rooms with 0 members after 10 min

// Track metadata bounds. Server controls thumbnails entirely to prevent
// tracking-pixel attacks (client supplies a URL pointing at attacker.com,
// and every other room member's browser fetches it on render, leaking IPs).
// Title/channel are still client-supplied but capped and sanitized.
const YT_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const MAX_TITLE_LEN = 200;
const MAX_CHANNEL_LEN = 100;
const MAX_DURATION_SEC = 24 * 60 * 60; // 24h — anything longer is bogus (honestly I have seen an 11 hours video of a dude explaining how computer works, check it out!)

function thumbnailFor(videoId) {
  // Always YouTube's own CDN. No client URLs ever stored in queue items.
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function sanitizeDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DURATION_SEC) return 0;
  return n;
}

// Read-only lookup. All handlers except room:join use this — phantom rooms
// can no longer be conjured by sending queue:add / host:transfer / playback:*
// with arbitrary room ids.
function getRoom(roomId) {
  return rooms[roomId];
}

// Creates a room if missing, enforcing the room-count cap. Only called from
// room:join. Returns null if the server is at the room cap.
function getOrCreateRoom(roomId) {
  if (rooms[roomId]) {
    // Reviving an empty room — cancel any pending cleanup.
    if (rooms[roomId]._cleanupTimer) {
      clearTimeout(rooms[roomId]._cleanupTimer);
      rooms[roomId]._cleanupTimer = null;
    }
    return rooms[roomId];
  }
  if (Object.keys(rooms).length >= MAX_ROOMS) {
    return null;
  }
  rooms[roomId] = {
    id: roomId,
    members: [],
    queue: [],
    playbackState: emptyPlaybackState(),
    _cleanupTimer: null,
  };
  return rooms[roomId];
}

function scheduleRoomCleanup(roomId) {
  const room = rooms[roomId];
  if (!room || room.members.length > 0) return;
  if (room._cleanupTimer) clearTimeout(room._cleanupTimer);
  room._cleanupTimer = setTimeout(() => {
    // Re-check at fire time — someone may have rejoined.
    const r = rooms[roomId];
    if (r && r.members.length === 0) {
      delete rooms[roomId];
      console.log(`[room] cleaned up empty room: ${roomId}`);
    }
  }, EMPTY_ROOM_TTL_MS);
}

function getMember(room, userId) {
  if (!room) return undefined;
  return room.members.find((m) => m.userId === userId);
}

function isHost(socket, room) {
  if (!room) return false;
  const member = getMember(room, socket.data?.userId);
  return member?.role === "host";
}

function broadcastPlaybackState(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  io.to(roomId).emit("playback:state", room.playbackState);
}

function setPlaybackFromTrack(room, track) {
  room.playbackState = {
    videoId: track.videoId,
    title: track.title,
    channel: track.channel,
    thumbnail: track.thumbnail,
    trackId: track.id,
    duration: track.duration ?? 0,
    positionSeconds: 0,
    isPlaying: true,
    updatedAt: Date.now(),
  };
}

function advanceToNextTrack(room, roomId) {
  if (room.queue.length === 0) {
    room.playbackState = emptyPlaybackState();
    io.to(roomId).emit("playback:track_ended", { nextItem: null });
    broadcastPlaybackState(roomId);
    return;
  }

  const nextItem = room.queue.shift();
  setPlaybackFromTrack(room, nextItem);

  io.to(roomId).emit("queue:updated", { queue: room.queue });
  io.to(roomId).emit("playback:track_ended", { nextItem });

  broadcastPlaybackState(roomId);
}

// ─────────────────────────────
// SOCKET RATE LIMITING
// ─────────────────────────────
// Tiny per-socket sliding-window limiter. No dependency; in-memory state
// dies with the socket. Sized to allow normal interactive use (fast typers,
// vote flipping) while killing flood attacks.
function makeSocketLimiter(maxEvents, windowMs) {
  return (socket, key) => {
    const now = Date.now();
    socket.data._rl = socket.data._rl || {};
    const arr = (socket.data._rl[key] = socket.data._rl[key] || []);
    while (arr.length && arr[0] < now - windowMs) arr.shift();
    if (arr.length >= maxEvents) return false;
    arr.push(now);
    return true;
  };
}

const chatLimiter = makeSocketLimiter(10, 10_000); // 10 msgs / 10s
const queueAddLimiter = makeSocketLimiter(5, 30_000); // 5 adds / 30s
const voteLimiter = makeSocketLimiter(20, 30_000); // 20 vote flips / 30s
const joinLimiter = makeSocketLimiter(5, 30_000); // 5 joins / 30s

// ─────────────────────────────
// SOCKETS
// ─────────────────────────────
io.on("connection", (socket) => {
  // Server-assigned identity. Client cannot set or override this — kills
  // impersonation where one user joins as another's userId.
  socket.data = { userId: crypto.randomUUID() };
  console.log(`[socket] connected: ${socket.id} (${socket.data.userId})`);

  // ── JOIN ROOM ──
  socket.on("room:join", ({ roomId, username }) => {
    if (!joinLimiter(socket, "join")) return;
    if (typeof roomId !== "string" || !roomId.trim()) return;

    // Username stays user-controlled but is sanitized server-side: trim,
    // cap length, reject empty/non-string. Display labels can collide; the
    // userId underneath is always unique.
    const cleanName =
      typeof username === "string" ? username.trim().slice(0, 32) : "";
    if (!cleanName) return;

    const userId = socket.data.userId;
    const room = getOrCreateRoom(roomId);
    if (!room) {
      // Server at MAX_ROOMS — refuse to spin up another room. Existing rooms
      // can still be joined.
      socket.emit("room:join_failed", {
        reason: "server at capacity, try again later",
      });
      return;
    }

    // Hard cap on members. Once full, only existing members can rejoin.
    if (
      !getMember(room, userId) &&
      room.members.length >= MAX_MEMBERS_PER_ROOM
    ) {
      socket.emit("room:join_failed", { reason: "room full" });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = cleanName;

    if (!getMember(room, userId)) {
      room.members.push({
        userId,
        username: cleanName,
        role: room.members.length === 0 ? "host" : "listener",
      });
      socket.to(roomId).emit("room:member_joined", {
        userId,
        username: cleanName,
      });
    }

    const member = getMember(room, userId);

    socket.emit("room:joined", {
      room: { id: roomId },
      userId,
      members: room.members,
      queue: room.queue,
      playbackState: room.playbackState,
      role: member?.role ?? "listener",
    });
  });

  // ── HOST TRANSFER ──
  socket.on("host:transfer", ({ roomId, newHostId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    if (!isHost(socket, room)) return;

    const currentHost = getMember(room, socket.data?.userId);
    const newHost = room.members.find((m) => m.userId === newHostId);

    if (!currentHost || !newHost) return;

    currentHost.role = "listener";
    newHost.role = "host";

    io.to(roomId).emit("host:changed", {
      newHostId: newHost.userId,
      newHostUsername: newHost.username,
    });
  });

  // ── QUEUE ──
  socket.on(
    "queue:add",
    // Note: client-supplied `thumbnail` is intentionally NOT destructured.
    ({ roomId, videoId, title, channel, duration }) => {
      if (!socket.data.username) return;
      if (!queueAddLimiter(socket, "queue:add")) return;

      // Reject anything that doesn't look like a YouTube video id. This is
      // the only field the server can't easily reconstruct, so it must be
      // validated tightly.
      if (typeof videoId !== "string" || !YT_VIDEO_ID_REGEX.test(videoId)) {
        return;
      }

      const room = getRoom(roomId);
      if (!room) return;

      // Hard cap on queue length per room. Rate limiter already throttles
      // burst additions; this catches sustained slow filling.
      if (room.queue.length >= MAX_QUEUE_LENGTH) {
        socket.emit("queue:full", { max: MAX_QUEUE_LENGTH });
        return;
      }

      const item = {
        id: Date.now().toString(),
        videoId,
        title: sanitizeText(title, MAX_TITLE_LEN) || "Untitled",
        channel: sanitizeText(channel, MAX_CHANNEL_LEN) || "Unknown",
        // Always server-derived. Discards any thumbnail the client sent —
        // kills the tracking-pixel privacy leak.
        thumbnail: thumbnailFor(videoId),
        duration: sanitizeDuration(duration),
        votes: 0,
        addedBy: socket.data.username,
        addedById: socket.data.userId,
      };

      room.queue.push(item);
      io.to(roomId).emit("queue:updated", { queue: room.queue });
    },
  );

  socket.on("queue:vote", ({ roomId, itemId, value }) => {
    if (!voteLimiter(socket, "queue:vote")) return;
    const room = getRoom(roomId);
    if (!room) return;

    const item = room.queue.find((i) => i.id === itemId);
    if (!item) return;

    const delta = value > 0 ? 1 : -1;
    if (delta === -1 && item.votes < 1) return;
    item.votes += delta;
    room.queue.sort((a, b) => b.votes - a.votes);

    io.to(roomId).emit("queue:updated", { queue: room.queue });
  });

  socket.on("queue:remove", ({ roomId, itemId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    if (!isHost(socket, room)) return;

    const idx = room.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return;

    room.queue.splice(idx, 1);
    io.to(roomId).emit("queue:updated", { queue: room.queue });
  });

  // ── CHAT ──
  socket.on("chat:send", ({ roomId, text }) => {
    // Identity is stamped from socket.data, never from the client payload.
    // Without this, anyone could forge messages from anyone.
    if (!socket.data.username) return;
    if (typeof text !== "string") return;

    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 500) return;

    if (!chatLimiter(socket, "chat")) {
      // Private feedback to just this socket — never broadcast. Doesn't
      // shame the user in chat; doesn't help attackers measure the limit
      // against anyone else's view.
      socket.emit("chat:rate_limited", { retryAfterMs: 5_000 });
      return;
    }

    io.to(roomId).emit("chat:message", {
      userId: socket.data.userId,
      username: socket.data.username,
      text: trimmed,
      timestamp: Date.now(),
    });
  });

  // ── PLAYBACK (HOST ONLY) ──
  socket.on("playback:play_track", ({ roomId, itemId }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;

    const idx = room.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return;

    const [item] = room.queue.splice(idx, 1);

    setPlaybackFromTrack(room, item);
    io.to(roomId).emit("queue:updated", { queue: room.queue });
    broadcastPlaybackState(roomId);
  });

  socket.on("playback:play", ({ roomId, positionSeconds }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.isPlaying = true;
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:pause", ({ roomId, positionSeconds }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.isPlaying = false;
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:seek", ({ roomId, positionSeconds }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:ended", ({ roomId }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;

    advanceToNextTrack(room, roomId);
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    const { roomId, userId } = socket.data || {};
    const room = rooms[roomId];

    if (!room) {
      console.log(`[socket] disconnected: ${socket.id}`);
      return;
    }

    const leaving = room.members.find((m) => m.userId === userId);
    const wasHost = leaving?.role === "host";

    room.members = room.members.filter((m) => m.userId !== userId);

    socket.to(roomId).emit("room:member_left", { userId });

    if (wasHost && room.members.length > 0) {
      const newHost = room.members[0];
      newHost.role = "host";

      io.to(roomId).emit("host:changed", {
        newHostId: newHost.userId,
        newHostUsername: newHost.username,
      });
    }

    // Last member out — schedule TTL cleanup. Cancelled if anyone rejoins
    // before the timer fires.
    if (room.members.length === 0) {
      scheduleRoomCleanup(roomId);
    }

    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
const PORT = process.env.PORT || 4000;

async function initializeServer() {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const binaryPath = path.join(__dirname, binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.log(`[setup] Downloading yt-dlp to ${binaryPath}...`);

    const downloadUrl =
      process.platform === "win32"
        ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
    fs.writeFileSync(binaryPath, Buffer.from(await res.arrayBuffer()));

    if (process.platform !== "win32") fs.chmodSync(binaryPath, "755");
    console.log("[setup] yt-dlp downloaded successfully.");
  }

  ytdlp = new YTDlpWrap(binaryPath);

  // Always update yt-dlp to latest on startup
  if (fs.existsSync(binaryPath)) {
    console.log("[setup] Updating yt-dlp...");
    try {
      await ytdlp.execPromise(["--update-to", "stable"]);
      console.log("[setup] yt-dlp updated.");
    } catch (e) {
      console.warn("[setup] yt-dlp update failed (continuing):", e.message);
    }
  }

  server.listen(PORT, () => {
    console.log(`vaux server running on http://localhost:${PORT}`);
  });
}

initializeServer().catch(console.error);
