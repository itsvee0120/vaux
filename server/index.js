require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
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

// ─────────────────────────────
// YOUTUBE SEARCH
// ─────────────────────────────
app.get("/youtube/search", async (req, res) => {
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

app.get("/youtube/stream", async (req, res) => {
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

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      members: [],
      queue: [],
      playbackState: emptyPlaybackState(),
    };
  }
  return rooms[roomId];
}

function getMember(room, userId) {
  return room.members.find((m) => m.userId === userId);
}

function isHost(socket, room) {
  const member = getMember(room, socket.data?.userId);
  return member?.role === "host";
}

function broadcastPlaybackState(roomId) {
  const room = getRoom(roomId);
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
// SOCKETS
// ─────────────────────────────
io.on("connection", (socket) => {
  // Server-assigned identity. Client cannot set or override this — kills
  // impersonation where one user joins as another's userId.
  socket.data = { userId: crypto.randomUUID() };
  console.log(`[socket] connected: ${socket.id} (${socket.data.userId})`);

  // ── JOIN ROOM ──
  socket.on("room:join", ({ roomId, username }) => {
    if (typeof roomId !== "string" || !roomId.trim()) return;

    // Username stays user-controlled but is sanitized server-side: trim,
    // cap length, reject empty/non-string. Display labels can collide; the
    // userId underneath is always unique.
    const cleanName =
      typeof username === "string" ? username.trim().slice(0, 32) : "";
    if (!cleanName) return;

    const userId = socket.data.userId;
    const room = getRoom(roomId);

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
    ({ roomId, videoId, title, channel, thumbnail, duration }) => {
      if (!socket.data.username) return;
      const room = getRoom(roomId);

      const item = {
        id: Date.now().toString(),
        videoId,
        title,
        channel,
        thumbnail,
        duration: duration ?? 0,
        votes: 0,
        addedBy: socket.data.username,
        addedById: socket.data.userId,
      };

      room.queue.push(item);
      io.to(roomId).emit("queue:updated", { queue: room.queue });
    },
  );

  socket.on("queue:vote", ({ roomId, itemId, value }) => {
    const room = getRoom(roomId);

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

    if (!room) return;

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
