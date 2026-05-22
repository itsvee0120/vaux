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

app.get("/health", (req, res) => {
  res.json({ status: "ok", project: "vaux" });
});

io.on("connection", (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on("room:join", ({ roomId, userId, username }) => {
    socket.join(roomId);
    console.log(`[room] ${username} joined ${roomId}`);
    socket.to(roomId).emit("room:member_joined", { userId, username });
    socket.emit("room:joined", {
      room: { id: roomId },
      members: [],
      queue: [],
      playbackState: { videoId: null, positionSeconds: 0, isPlaying: false },
    });
  });

  socket.on("chat:send", ({ roomId, userId, username, text }) => {
    const message = { userId, username, text, timestamp: Date.now() };
    io.to(roomId).emit("chat:message", message);
  });

  socket.on("disconnect", () => {
    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`vaux server running on http://localhost:${PORT}`);
});
