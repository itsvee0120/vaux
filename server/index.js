require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// ── health check ──
app.get("/health", (req, res) => {
  res.json({ status: "ok", project: "vaux" });
});

// ── youtube search ──
app.get("/youtube/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "query required" });

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoCategoryId", "10"); // music category
    url.searchParams.set("maxResults", "8");
    url.searchParams.set("q", q);
    url.searchParams.set("key", process.env.YOUTUBE_API_KEY);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      console.error("[youtube] API error:", data);
      return res.status(500).json({ error: "YouTube API error", detail: data });
    }

    const results = data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium.url,
    }));

    res.json({ results });
  } catch (err) {
    console.error("[youtube] fetch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── in-memory room state (db comes later) ──
const rooms = {};

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

// ── socket.io ──
io.on("connection", (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on("room:join", ({ roomId, userId, username }) => {
    const room = getRoom(roomId);
    socket.join(roomId);
    socket.data = { roomId, userId, username };

    if (!room.members.find((m) => m.userId === userId)) {
      room.members.push({
        userId,
        username,
        role: room.members.length === 0 ? "host" : "listener",
      });
    }

    console.log(`[room] ${username} joined ${roomId}`);

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
    if (item) {
      item.votes += value;
      room.queue.sort((a, b) => b.votes - a.votes);
      io.to(roomId).emit("queue:updated", { queue: room.queue });
    }
  });

  socket.on("chat:send", ({ roomId, userId, username, text }) => {
    const message = { userId, username, text, timestamp: Date.now() };
    io.to(roomId).emit("chat:message", message);
  });

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
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.isPlaying = true;
    room.playbackState.updatedAt = Date.now();
    broadcastPlaybackState(roomId);
  });

  socket.on("playback:pause", ({ roomId, positionSeconds }) => {
    const room = getRoom(roomId);
    if (!isHost(socket, room)) return;
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.isPlaying = false;
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

  socket.on("disconnect", () => {
    const { roomId, userId } = socket.data || {};
    if (roomId && rooms[roomId]) {
      rooms[roomId].members = rooms[roomId].members.filter(
        (m) => m.userId !== userId,
      );
      socket.to(roomId).emit("room:member_left", { userId });
    }
    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vaux server running on http://localhost:${PORT}`);
});
