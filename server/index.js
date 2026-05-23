require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const YTDlpWrap = require("yt-dlp-wrap").default || require("yt-dlp-wrap");
const ytdlp = new YTDlpWrap();

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
// YOUTUBE SEARCH
// ─────────────────────────────
app.get("/youtube/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "query required" });

  try {
    const stdout = await ytdlp.execPromise([
      `ytsearch8:${q}`,
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
    }));

    res.json({ results });
  } catch (err) {
    console.error("[youtube] search error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ─────────────────────────────
// YOUTUBE STREAM URL RESOLVER
// ─────────────────────────────
const streamCache = new Map();

app.get("/youtube/stream-url", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "videoId required" });

  if (streamCache.has(videoId)) {
    return res.json({ streamUrl: streamCache.get(videoId) });
  }

  try {
    const stdout = await ytdlp.execPromise([
      "-f",
      "bestaudio/best",
      "--get-url",
      "--no-warnings",
      "--extractor-args",
      "youtube:player_client=android",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    const streamUrl = stdout.trim();
    if (!streamUrl)
      return res.status(404).json({ error: "No audio stream found" });

    streamCache.set(videoId, streamUrl);
    // Expire cache after 4 hours (Google CDN URLs typically expire in ~6 hours)
    setTimeout(() => streamCache.delete(videoId), 4 * 60 * 60 * 1000);

    res.json({ streamUrl });
  } catch (err) {
    console.error("[ytdlp] server error:", err);
    res.status(500).json({ error: "Failed to get stream URL" });
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
  console.log(`[socket] connected: ${socket.id}`);

  // ── JOIN ROOM ──
  socket.on("room:join", ({ roomId, userId, username }) => {
    const room = getRoom(roomId);

    socket.join(roomId);
    socket.data = { roomId, userId, username };

    const existing = room.members.find((m) => m.userId === userId);

    if (!existing) {
      room.members.push({
        userId,
        username,
        role: room.members.length === 0 ? "host" : "listener",
      });
    }

    socket.to(roomId).emit("room:member_joined", { userId, username });

    const member = getMember(room, userId);

    socket.emit("room:joined", {
      room: { id: roomId },
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
  socket.on("queue:add", ({ roomId, videoId, title, channel, thumbnail }) => {
    const room = getRoom(roomId);

    const item = {
      id: Date.now().toString(),
      videoId,
      title,
      channel,
      thumbnail,
      votes: 0,
      addedBy: socket.data.username,
    };

    room.queue.push(item);
    io.to(roomId).emit("queue:updated", { queue: room.queue });
  });

  socket.on("queue:vote", ({ roomId, itemId, value }) => {
    const room = getRoom(roomId);

    const item = room.queue.find((i) => i.id === itemId);
    if (!item) return;

    item.votes += value;
    room.queue.sort((a, b) => b.votes - a.votes);

    io.to(roomId).emit("queue:updated", { queue: room.queue });
  });

  // ── CHAT ──
  socket.on("chat:send", ({ roomId, userId, username, text }) => {
    io.to(roomId).emit("chat:message", {
      userId,
      username,
      text,
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
server.listen(PORT, () => {
  console.log(`vaux server running on http://localhost:${PORT}`);
});
