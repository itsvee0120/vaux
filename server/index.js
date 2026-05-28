require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const argon2 = require("argon2");

const YTDlpWrap = require("yt-dlp-wrap").default || require("yt-dlp-wrap");
let ytdlp = new YTDlpWrap();

// Modern YouTube extraction needs a JS runtime and EJS challenge scripts.
//
// The player_client fallback chain matters when running from datacenter IPs
// (Render, Fly, etc.) because YouTube's bot challenge is non-deterministic and
// triggers more aggressively for the default web client than for tv/safari/mweb
// surfaces. yt-dlp tries each client in order until one returns a usable
// stream, so a transient gate on the default client doesn't reach our caller.
// Order is "least-gated first" per yt-dlp community reports for cloud IPs;
// rotate if YouTube's gating shifts. Cookies/PO-tokens are heavier escalations
// (account-ban risk, secret rotation) deferred until this stops being enough.
function ytdlpBaseArgs(playerClients = "tv,web_safari,mweb,default") {
  return [
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    "--extractor-args",
    `youtube:player_client=${playerClients}`,
  ];
}

// Alternate client chains for datacenter IPs (Render, etc.). Tried in order.
const YTDLP_PLAYER_CLIENT_CHAINS = [
  "tv,web_safari,mweb,default",
  "web_embedded,tv_embedded",
  "mweb,web",
];

function classifyYtDlpError(message) {
  const text = String(message || "");
  if (
    /sign in to confirm you.?re not a bot/i.test(text) ||
    /confirm you.?re not a bot/i.test(text)
  ) {
    return {
      code: "bot_challenge",
      error:
        "YouTube blocked extraction on the server (bot challenge). Try again or use CLI local yt-dlp.",
    };
  }
  if (
    /private video|members.only|age.restricted|unavailable|removed|not available/i.test(
      text,
    )
  ) {
    return {
      code: "unavailable",
      error: "Video unavailable or restricted on YouTube.",
    };
  }
  return { code: "unknown", error: "could not resolve stream" };
}

async function ytdlpExecWithClientChains(
  watchUrl,
  extraArgs,
  { stopOnBotChallenge = false } = {},
) {
  let lastFailure = classifyYtDlpError("unknown");
  for (const clients of YTDLP_PLAYER_CLIENT_CHAINS) {
    try {
      const stdout = await ytdlp.execPromise([
        watchUrl,
        ...ytdlpBaseArgs(clients),
        ...extraArgs,
      ]);
      return { ok: true, stdout };
    } catch (err) {
      lastFailure = classifyYtDlpError(err.message || String(err));
      if (stopOnBotChallenge && lastFailure.code === "bot_challenge") break;
    }
  }
  return { ok: false, ...lastFailure };
}

const app = express();

// Render (and most PaaS hosts) terminate TLS at a reverse proxy and forward
// the real client IP in X-Forwarded-For. Without this, express-rate-limit
// either (a) refuses to start, citing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, or
// (b) keys every request off the proxy's IP — i.e. one shared bucket for the
// entire internet, so a single noisy client locks out everyone. Trusting
// exactly one hop is the documented fix; `true` would let any client forge
// X-Forwarded-For and trivially bypass the limiter.
app.set("trust proxy", 1);

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
    const result = await ytdlpExecWithClientChains(
      `ytsearch${limit}:${q}`,
      ["--dump-single-json", "--flat-playlist", "--no-warnings"],
      { stopOnBotChallenge: true },
    );
    if (!result.ok) {
      console.warn("[youtube] search error:", { query: q, ...result });
      const status = result.code === "bot_challenge" ? 503 : 502;
      return res.status(status).json({
        error: result.error,
        code: result.code,
        results: [],
      });
    }

    const data = JSON.parse(result.stdout);
    const entries = data.entries || [];

    const results = entries.map((item) => ({
      videoId: item.id,
      title: item.title,
      channel: item.uploader || item.channel || "YouTube",
      // Server-derived, same as queue items. yt-dlp's `thumbnails[0].url`
      // can point at any host the extractor felt like returning — using it
      // would reopen the tracking-pixel hole fix #4 closed on the queue
      // path, just one step earlier in the flow (search results render
      // before the user even clicks add).
      thumbnail: thumbnailFor(item.id),
      duration: item.duration ?? 0,
    }));

    res.json({ results });
  } catch (err) {
    console.error("[youtube] search error:", err);
    res.status(500).json({ error: "internal server error", code: "unknown" });
  }
});

async function resolveStreamUrl(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const result = await ytdlpExecWithClientChains(watchUrl, [
    "--get-url",
    "--no-warnings",
    "-f",
    "bestaudio/best",
  ], { stopOnBotChallenge: true });
  if (result.ok) {
    const url = result.stdout.trim().split(/\r?\n/).find(Boolean) || null;
    if (url) return { ok: true, url };
    return {
      ok: false,
      code: "unknown",
      error: "could not resolve stream",
    };
  }
  console.warn("[youtube] stream extraction failed:", {
    videoId,
    code: result.code,
    error: result.error,
  });
  return result;
}

app.get("/youtube/stream", streamLimiter, async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "videoId required" });

  try {
    const result = await resolveStreamUrl(videoId);
    if (result.ok) {
      return res.json({ url: result.url });
    }
    const status = result.code === "bot_challenge" ? 503 : 502;
    return res.status(status).json({
      error: result.error,
      code: result.code,
    });
  } catch (err) {
    console.error("[youtube] stream error:", err);
    res.status(500).json({ error: "internal server error", code: "unknown" });
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

// Private rooms — see PRIVATE_ROOMS_SPEC.md for full design.
// Blip TTL is env-overridable so integration tests can drive it down to
// ~200 ms without waiting 5 s per assertion. Prod uses the 5 s default.
const PRIVATE_ROOM_BLIP_MS = Number(process.env.PRIVATE_ROOM_BLIP_MS) || 5_000;
const PRIVATE_ROOM_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;
const PRIVATE_LOCKOUT_AFTER = 10;
const PRIVATE_LOCKOUT_DURATION_MS = 60_000;
const PRIVATE_LOCKOUT_GC_INTERVAL_MS = 5 * 60_000;
const PRIVATE_LOCKOUT_GC_AFTER_MS = 60 * 60_000;
const PRIVATE_LOCKOUT_MAP_MAX = 50_000;
const PRIVATE_AUTH_PROOF_BYTES = 32;

const IS_DEV = process.env.NODE_ENV !== "production";
const LOG_PRIVATE = process.env.LOG_PRIVATE_ROOMS === "true" || IS_DEV;
function logPrivate(...args) {
  if (LOG_PRIVATE) console.log("[private]", ...args);
}

const privateRoomLockouts = new Map();

function recordFailedAttempt(roomId) {
  const now = Date.now();
  let entry = privateRoomLockouts.get(roomId);
  if (!entry) {
    if (privateRoomLockouts.size >= PRIVATE_LOCKOUT_MAP_MAX) {
      evictOldestLockouts();
    }
    entry = { failedAttempts: 0, lockedUntil: 0, lastTouchedMs: now };
    privateRoomLockouts.set(roomId, entry);
  }
  entry.failedAttempts += 1;
  entry.lastTouchedMs = now;
  if (entry.failedAttempts >= PRIVATE_LOCKOUT_AFTER) {
    entry.lockedUntil = now + PRIVATE_LOCKOUT_DURATION_MS;
  }
  return entry;
}

function clearLockout(roomId) {
  privateRoomLockouts.delete(roomId);
}

function checkLockout(roomId) {
  const entry = privateRoomLockouts.get(roomId);
  if (!entry) return null;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : null;
}

function evictOldestLockouts() {
  const evictCount = Math.max(1, Math.floor(PRIVATE_LOCKOUT_MAP_MAX / 10));
  const sorted = [...privateRoomLockouts.entries()].sort(
    (a, b) => a[1].lastTouchedMs - b[1].lastTouchedMs,
  );
  for (let i = 0; i < evictCount && i < sorted.length; i++) {
    privateRoomLockouts.delete(sorted[i][0]);
  }
}

setInterval(() => {
  const now = Date.now();
  const idleCutoff = now - PRIVATE_LOCKOUT_GC_AFTER_MS;
  for (const [roomId, entry] of privateRoomLockouts) {
    if (entry.lockedUntil < now && entry.lastTouchedMs < idleCutoff) {
      privateRoomLockouts.delete(roomId);
    }
  }
}, PRIVATE_LOCKOUT_GC_INTERVAL_MS).unref();

function decodeAuthProof(authProofB64) {
  if (typeof authProofB64 !== "string") return null;
  try {
    const buf = Buffer.from(authProofB64, "base64");
    if (buf.length !== PRIVATE_AUTH_PROOF_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

const CIPHER_FIELD_MAX_CHARS = 200;

// Private-room display names are sent as { ct, nonce } encrypted under
// chatKey. Server never looks inside — just bounds-checks the strings to
// stop a misbehaving client from emitting a 1MB "username".
function validateUsernameCipher(value) {
  if (!value || typeof value !== "object") return null;
  const { ct, nonce } = value;
  if (typeof ct !== "string" || typeof nonce !== "string") return null;
  if (!ct || ct.length > CIPHER_FIELD_MAX_CHARS) return null;
  if (!nonce || nonce.length > CIPHER_FIELD_MAX_CHARS) return null;
  return { ct, nonce };
}

// Track metadata bounds. Server controls thumbnails entirely to prevent
// tracking-pixel attacks (client supplies a URL pointing at attacker.com,
// and every other room member's browser fetches it on render, leaking IPs).
// Title/channel are still client-supplied but capped and sanitized.
const YT_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const MAX_TITLE_LEN = 200;
const MAX_CHANNEL_LEN = 100;
const MAX_DURATION_SEC = 24 * 60 * 60; // 24h — anything longer is bogus

// Public-room id format. Rejects unicode/emoji/path-traversal junk that would
// otherwise let a bot fill the MAX_ROOMS cap with garbage keys. Matches every
// slug from generateRoomSlug() (verified) and accepts any lowercase
// `[a-z0-9-]` name a human is likely to type. Lowercase-only is intentional
// — keeps "myroom" and "MyRoom" from fragmenting into two rooms.
const PUBLIC_ROOM_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

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

// Creates a public room if missing, enforcing the room-count cap. Only
// called from the public room:join path. Private rooms are created via
// createPrivateRoom (see below) so we never accidentally cancel a private
// room's blip timer for an unauthenticated socket.
function getOrCreateRoom(roomId) {
  if (rooms[roomId]) {
    if (rooms[roomId].private) return null; // refuse public-flow on private room
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
    private: false,
    authHash: null,
  };
  return rooms[roomId];
}

function createPrivateRoom(roomId, authHash) {
  if (rooms[roomId]) return null;
  if (Object.keys(rooms).length >= MAX_ROOMS) return null;
  rooms[roomId] = {
    id: roomId,
    members: [],
    queue: [],
    playbackState: emptyPlaybackState(),
    _cleanupTimer: null,
    private: true,
    authHash,
  };
  return rooms[roomId];
}

function cancelCleanupTimer(room) {
  if (room?._cleanupTimer) {
    clearTimeout(room._cleanupTimer);
    room._cleanupTimer = null;
  }
}

function scheduleRoomCleanup(roomId) {
  const room = rooms[roomId];
  if (!room || room.members.length > 0) return;
  if (room._cleanupTimer) clearTimeout(room._cleanupTimer);
  const ttl = room.private ? PRIVATE_ROOM_BLIP_MS : EMPTY_ROOM_TTL_MS;
  const wasPrivate = room.private;
  room._cleanupTimer = setTimeout(() => {
    const r = rooms[roomId];
    if (r && r.members.length === 0) {
      delete rooms[roomId];
      if (wasPrivate) {
        logPrivate("room cleanup fired");
      } else {
        console.log(`[room] cleaned up empty room: ${roomId}`);
      }
    }
  }, ttl);
}

function getMember(room, userId) {
  if (!room) return undefined;
  return room.members.find((m) => m.userId === userId);
}

// Every post-join handler takes a client-supplied roomId. Reject unless it
// matches socket.data.roomId and this socket is still a listed member.
function getJoinedRoom(socket, roomId) {
  if (typeof roomId !== "string" || !roomId) return null;
  if (socket.data?.roomId !== roomId) return null;
  const room = getRoom(roomId);
  if (!room || !getMember(room, socket.data.userId)) return null;
  return room;
}

// Drop member rows whose userId has no live socket in the room (stale tabs,
// crashed clients, probe-era ghosts). Silent — no member_left broadcast.
function pruneDisconnectedMembers(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  const adapter = io.sockets.adapter.rooms.get(roomId);
  if (!adapter) {
    room.members = [];
    return;
  }
  const live = new Set();
  for (const sid of adapter) {
    const sock = io.sockets.sockets.get(sid);
    if (sock?.data?.userId) live.add(sock.data.userId);
  }
  room.members = room.members.filter((m) => live.has(m.userId));
}

// Shared leave path for disconnect and room:join switching rooms.
function removeMemberFromRoom(socket, roomId) {
  const room = getRoom(roomId);
  const userId = socket.data?.userId;
  if (!room || !userId) return;
  if (socket.data._removedFrom === roomId) return;

  const leaving = getMember(room, userId);
  if (!leaving) return;
  socket.data._removedFrom = roomId;

  const wasHost = leaving.role === "host";
  room.members = room.members.filter((m) => m.userId !== userId);

  if (socket.connected) socket.leave(roomId);
  // Private rooms are ephemeral by design: if host leaves without an explicit
  // transfer, end the room instead of auto-promoting a new host.
  if (wasHost && room.private) {
    cancelCleanupTimer(room);
    io.to(roomId).emit("room:ended", {
      reason: "host_left_without_transfer",
      roomId,
    });
    io.in(roomId).disconnectSockets(true);
    delete rooms[roomId];
    logPrivate("room destroyed by host disconnect");
    return;
  }

  socket.to(roomId).emit("room:member_left", { userId });

  if (wasHost && room.members.length > 0) {
    const newHost = room.members[0];
    newHost.role = "host";
    io.to(roomId).emit("host:changed", {
      newHostId: newHost.userId,
      newHostUsername: room.private ? undefined : newHost.username,
      newHostUsernameCipher: room.private
        ? newHost.usernameCipher
        : undefined,
    });
  }

  if (room.members.length === 0) {
    scheduleRoomCleanup(roomId);
  }
}

function leavePreviousRoom(socket, nextRoomId) {
  const prevId = socket.data?.roomId;
  if (!prevId || prevId === nextRoomId) return;
  removeMemberFromRoom(socket, prevId);
  socket.data.roomId = undefined;
  if (socket.data.private) {
    socket.data.private = false;
    socket.data.usernameCipher = undefined;
  }
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

async function joinPrivateRoom(
  socket,
  { roomId, usernameCipher, authProofB64, create, userId, probe },
) {
  if (!PRIVATE_ROOM_ID_REGEX.test(roomId)) {
    socket.emit("room:join_failed", { reason: "auth_failed" });
    return;
  }

  const lockedFor = checkLockout(roomId);
  if (lockedFor !== null) {
    socket.emit("room:join_failed", {
      reason: "locked",
      retryAfterMs: lockedFor,
    });
    return;
  }

  const authProof = decodeAuthProof(authProofB64);
  if (!authProof) {
    socket.emit("room:join_failed", { reason: "auth_failed" });
    return;
  }

  let room = getRoom(roomId);

  if (!room) {
    if (!create) {
      // Don't confirm whether the room exists. Wrong-password and not-found
      // collapse into the same response.
      recordFailedAttempt(roomId);
      logPrivate("join attempt: room not found");
      socket.emit("room:join_failed", { reason: "auth_failed" });
      return;
    }
    if (Object.keys(rooms).length >= MAX_ROOMS) {
      socket.emit("room:join_failed", { reason: "capacity" });
      return;
    }
    if (probe) {
      socket.emit("room:joined", { probe: true, private: true });
      return;
    }
    let authHash;
    try {
      authHash = await argon2.hash(authProof, { type: argon2.argon2id });
    } catch (err) {
      logPrivate("argon2 hash error");
      socket.emit("room:join_failed", { reason: "auth_failed" });
      return;
    }
    room = createPrivateRoom(roomId, authHash);
    if (!room) {
      socket.emit("room:join_failed", { reason: "capacity" });
      return;
    }
    logPrivate("room created");
  } else {
    if (!room.private) {
      // A public room exists at this roomId — refuse to expose it via the
      // private flow. Generic failure.
      socket.emit("room:join_failed", { reason: "auth_failed" });
      return;
    }
    let ok = false;
    try {
      ok = await argon2.verify(room.authHash, authProof);
    } catch {
      ok = false;
    }
    if (!ok) {
      const entry = recordFailedAttempt(roomId);
      logPrivate(
        `auth failed (count=${entry.failedAttempts}, locked=${entry.lockedUntil > Date.now()})`,
      );
      socket.emit("room:join_failed", { reason: "auth_failed" });
      return;
    }
    if (!probe) {
      cancelCleanupTimer(room);
      logPrivate("auth ok");
    }
  }

  if (
    !getMember(room, userId) &&
    room.members.length >= MAX_MEMBERS_PER_ROOM
  ) {
    socket.emit("room:join_failed", { reason: "room full" });
    return;
  }

  if (probe) {
    socket.emit("room:joined", { probe: true, private: true });
    return;
  }

  clearLockout(roomId);

  leavePreviousRoom(socket, roomId);

  socket.join(roomId);
  socket.data.roomId = roomId;
  delete socket.data._removedFrom;
  // Server has no plaintext username for private members. Use the userId
  // as the chat-send identity gate — non-empty means "joined a room".
  socket.data.username = userId;
  socket.data.usernameCipher = usernameCipher;
  socket.data.private = true;
  pruneDisconnectedMembers(roomId);

  const existing = getMember(room, userId);
  if (existing) {
    existing.usernameCipher = usernameCipher;
    socket.to(roomId).emit("room:member_joined", { userId, usernameCipher });
  } else {
    room.members.push({
      userId,
      usernameCipher,
      role: room.members.length === 0 ? "host" : "listener",
    });
    socket.to(roomId).emit("room:member_joined", { userId, usernameCipher });
  }

  const member = getMember(room, userId);

  socket.emit("room:joined", {
    room: { id: roomId, private: true },
    userId,
    members: room.members,
    queue: room.queue,
    playbackState: room.playbackState,
    role: member?.role ?? "listener",
    private: true,
  });
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
  // Public flow: { roomId, username }
  // Private flow: { roomId, username, authProof, create? }
  // The presence of `authProof` switches the handler into the private path.
  //
  // Protocol assumption (private flow): `authProof` MUST be subkey 2 of the
  // client's crypto.ts/crypto.py KDF derivation (32 bytes, base64). On
  // create, the server stores its argon2id hash as the room secret — if the
  // client sends a weak value here, the room is only as strong as that
  // value. The server cannot enforce derivation; this is a client-side
  // contract. See PRIVATE_ROOMS_SPEC.md.
  socket.on("room:join", async ({ roomId, username, authProof, create, probe }) => {
    if (!joinLimiter(socket, "join")) return;
    if (typeof roomId !== "string" || !roomId.trim()) return;

    const userId = socket.data.userId;
    const wantsPrivate = authProof !== undefined;
    const isProbe = Boolean(probe);

    if (wantsPrivate) {
      // Private rooms ship username as { ct, nonce } (encrypted with chatKey).
      // Server treats it as an opaque relay payload — see PRIVATE_ROOMS_SPEC.md.
      const cipher = validateUsernameCipher(username);
      if (!cipher) {
        socket.emit("room:join_failed", { reason: "auth_failed" });
        return;
      }
      await joinPrivateRoom(socket, {
        roomId,
        usernameCipher: cipher,
        authProofB64: authProof,
        create: Boolean(create),
        userId,
        probe: isProbe,
      });
      return;
    }

    const cleanName =
      typeof username === "string" ? username.trim().slice(0, 32) : "";
    if (!cleanName) return;

    if (!PUBLIC_ROOM_ID_REGEX.test(roomId)) {
      // Reject malformed public room ids early so bots can't fill MAX_ROOMS
      // with unicode/emoji/path-traversal keys.
      socket.emit("room:join_failed", { reason: "invalid room name" });
      return;
    }

    let room = getRoom(roomId);

    if (isProbe) {
      if (!room) {
        if (Object.keys(rooms).length >= MAX_ROOMS) {
          socket.emit("room:join_failed", {
            reason: "server at capacity, try again later",
          });
          return;
        }
        socket.emit("room:joined", { probe: true });
        return;
      }
      if (room.private) {
        socket.emit("room:join_failed", {
          reason: "server at capacity, try again later",
        });
        return;
      }
      if (
        !getMember(room, userId) &&
        room.members.length >= MAX_MEMBERS_PER_ROOM
      ) {
        socket.emit("room:join_failed", { reason: "room full" });
        return;
      }
      socket.emit("room:joined", { probe: true });
      return;
    }

    room = getOrCreateRoom(roomId);
    if (!room) {
      // Either at MAX_ROOMS or this roomId belongs to a private room and
      // can't be joined via the public flow. Same generic message either way.
      socket.emit("room:join_failed", {
        reason: "server at capacity, try again later",
      });
      return;
    }

    if (
      !getMember(room, userId) &&
      room.members.length >= MAX_MEMBERS_PER_ROOM
    ) {
      socket.emit("room:join_failed", { reason: "room full" });
      return;
    }

    leavePreviousRoom(socket, roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    delete socket.data._removedFrom;
    socket.data.username = cleanName;
    pruneDisconnectedMembers(roomId);

    const existing = getMember(room, userId);
    if (existing) {
      existing.username = cleanName;
      socket.to(roomId).emit("room:member_joined", {
        userId,
        username: cleanName,
      });
    } else {
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

  socket.on("room:destroy", ({ roomId }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!room || !room.private) return;
    if (!isHost(socket, room)) return;
    cancelCleanupTimer(room);
    io.to(roomId).emit("room:ended", {
      reason: "host_left_without_transfer",
      roomId,
    });
    io.in(roomId).disconnectSockets(true);
    delete rooms[roomId];
    logPrivate("room destroyed by host");
  });

  // ── HOST TRANSFER ──
  socket.on("host:transfer", ({ roomId, newHostId }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!room) return;
    if (!isHost(socket, room)) return;

    const currentHost = getMember(room, socket.data?.userId);
    const newHost = room.members.find((m) => m.userId === newHostId);

    if (!currentHost || !newHost) return;

    currentHost.role = "listener";
    newHost.role = "host";

    // Private rooms relay the cipher object stored on the member; public
    // rooms relay the plaintext username field. Each receiver decrypts only
    // when it knows the chatKey.
    io.to(roomId).emit("host:changed", {
      newHostId: newHost.userId,
      newHostUsername: room.private ? undefined : newHost.username,
      newHostUsernameCipher: room.private ? newHost.usernameCipher : undefined,
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

      const room = getJoinedRoom(socket, roomId);
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
        // Private rooms have no plaintext username server-side
        // (socket.data.username is the userId UUID). Receiving clients
        // resolve addedById against their decrypted member map.
        addedBy: socket.data.private ? undefined : socket.data.username,
        addedById: socket.data.userId,
      };

      room.queue.push(item);
      io.to(roomId).emit("queue:updated", { queue: room.queue });
    },
  );

  socket.on("queue:vote", ({ roomId, itemId, value }) => {
    if (!voteLimiter(socket, "queue:vote")) return;
    const room = getJoinedRoom(socket, roomId);
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
    const room = getJoinedRoom(socket, roomId);
    if (!room) return;
    if (!isHost(socket, room)) return;

    const idx = room.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return;

    room.queue.splice(idx, 1);
    io.to(roomId).emit("queue:updated", { queue: room.queue });
  });

  // ── CHAT ──
  // Public rooms: { roomId, text }                — text is plaintext ≤500 chars.
  // Private rooms: { roomId, ct, nonce }          — both base64. Server relays
  // opaquely; never inspects content. See PRIVATE_ROOMS_SPEC.md.
  socket.on("chat:send", ({ roomId, text, ct, nonce }) => {
    if (!socket.data.username) return;
    if (!getJoinedRoom(socket, roomId)) return;

    let payload;
    if (socket.data.private) {
      if (typeof ct !== "string" || typeof nonce !== "string") return;
      if (!ct || ct.length > 2000) return;
      if (!nonce || nonce.length > CIPHER_FIELD_MAX_CHARS) return;
      payload = { ct, nonce };
    } else {
      if (typeof text !== "string") return;
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 500) return;
      payload = { text: trimmed };
    }

    if (!chatLimiter(socket, "chat")) {
      socket.emit("chat:rate_limited", { retryAfterMs: 5_000 });
      return;
    }

    // Private rooms omit username — receiving clients look it up in their
    // decrypted member map by userId.
    io.to(roomId).emit("chat:message", {
      userId: socket.data.userId,
      username: socket.data.private ? undefined : socket.data.username,
      ...payload,
      timestamp: Date.now(),
    });
  });

  // ── PLAYBACK (HOST ONLY) ──
  socket.on("playback:play_track", ({ roomId, itemId }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!isHost(socket, room)) return;

    const idx = room.queue.findIndex((i) => i.id === itemId);
    if (idx === -1) return;

    const [item] = room.queue.splice(idx, 1);

    setPlaybackFromTrack(room, item);
    io.to(roomId).emit("queue:updated", { queue: room.queue });
    broadcastPlaybackState(roomId);
  });

  socket.on("playback:play", ({ roomId, positionSeconds }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.isPlaying = true;
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:pause", ({ roomId, positionSeconds }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.isPlaying = false;
    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:seek", ({ roomId, positionSeconds }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!isHost(socket, room)) return;

    room.playbackState.positionSeconds = positionSeconds;
    room.playbackState.updatedAt = Date.now();

    broadcastPlaybackState(roomId);
  });

  socket.on("playback:ended", ({ roomId }) => {
    const room = getJoinedRoom(socket, roomId);
    if (!isHost(socket, room)) return;

    advanceToNextTrack(room, roomId);
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    const { roomId, private: wasPrivate } = socket.data || {};

    if (!roomId) {
      if (wasPrivate) {
        logPrivate("socket disconnect (no room)");
      } else {
        console.log(`[socket] disconnected: ${socket.id}`);
      }
      return;
    }

    removeMemberFromRoom(socket, roomId);

    if (wasPrivate) {
      logPrivate("socket disconnect");
    } else {
      console.log(`[socket] disconnected: ${socket.id}`);
    }
  });
});

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
const PORT = process.env.PORT || 4000;

// Pin yt-dlp to a known release AND a known hash. Auto-fetching "latest"
// means a compromised or maliciously published yt-dlp release lands on
// the next server boot without review. The hash is pinned in source —
// not fetched alongside the binary — so an attacker who publishes a
// malicious release can't also publish a matching SHA2-256SUMS file and
// have it pass verification. The trust anchor lives here, in vaux's repo.
//
// Values are GitHub's published asset digests for the tagged release,
// equivalent to the entries in SHA2-256SUMS for the same tag. To rotate:
//   1. Pick a release: https://github.com/yt-dlp/yt-dlp/releases
//   2. Pull its asset digests (and ideally also verify SHA2-256SUMS.sig
//      against the yt-dlp PGP key at yt-dlp/yt-dlp:master/public.key):
//        curl -s https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/<TAG> \
//          | jq -r '.assets[] | select(.name=="yt-dlp" or .name=="yt-dlp.exe") | "\(.name) \(.digest)"'
//   3. Update YT_DLP_VERSION + YT_DLP_SHA256 below.
//   4. Delete server/yt-dlp(.exe) so the next boot redownloads and reverifies.
const YT_DLP_VERSION = "2026.03.17";
const YT_DLP_SHA256 = {
  "yt-dlp.exe":
    "3db811b366b2da47337d2fcfdfe5bbd9a258dad3f350c54974f005df115a1545",
  "yt-dlp": "3bda0968a01cde70d26720653003b28553c71be14dcb2e5f4c24e9921fdad745",
};
const YT_DLP_RELEASE_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}`;

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function downloadAndVerify(binaryPath, binaryName, expectedSha256) {
  const url = `${YT_DLP_RELEASE_BASE}/${binaryName}`;
  console.log(`[setup] Downloading yt-dlp ${YT_DLP_VERSION} from ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

  // Hash in memory before touching disk. A blob that fails verification
  // never lands on the filesystem and never gets a chance to be spawned
  // by yt-dlp-wrap on a botched cleanup path.
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `yt-dlp checksum mismatch — refusing to run.\n` +
        `  expected: ${expectedSha256}\n` +
        `  actual:   ${actual}\n` +
        `Possible supply-chain tampering, republished release, or wrong YT_DLP_VERSION pin.`,
    );
  }
  fs.writeFileSync(binaryPath, buf);
  if (process.platform !== "win32") fs.chmodSync(binaryPath, "755");
  console.log(`[setup] yt-dlp ${YT_DLP_VERSION} downloaded and verified.`);
}

async function initializeServer() {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const binaryPath = path.join(__dirname, binaryName);
  const expectedSha256 = YT_DLP_SHA256[binaryName];

  if (!expectedSha256) {
    // No pinned hash for this platform — refusing to boot is the only safe
    // option. Silently defaulting to "trust whatever's on disk" defeats the
    // entire point of this gate.
    throw new Error(
      `no pinned SHA-256 for asset "${binaryName}" — refusing to start without supply-chain verification`,
    );
  }

  if (fs.existsSync(binaryPath)) {
    const actual = sha256File(binaryPath);
    if (actual === expectedSha256) {
      console.log(
        `[setup] existing yt-dlp matches pinned ${YT_DLP_VERSION} (verified).`,
      );
    } else {
      console.warn(
        `[setup] existing yt-dlp does NOT match pinned ${YT_DLP_VERSION}; re-downloading.`,
      );
      fs.unlinkSync(binaryPath);
      await downloadAndVerify(binaryPath, binaryName, expectedSha256);
    }
  } else {
    await downloadAndVerify(binaryPath, binaryName, expectedSha256);
  }

  ytdlp = new YTDlpWrap(binaryPath);

  // No auto-update on boot. Auto-updates defeat the whole point of pinning —
  // a compromised future release would replace the verified binary silently.
  // To update: bump YT_DLP_VERSION + YT_DLP_SHA256 above and redeploy.

  server.listen(PORT, () => {
    console.log(`vaux server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  initializeServer().catch((err) => {
    console.error("[setup] fatal:", err.message || err);
    process.exit(1);
  });
}

// Tests import this module to spin up the server on an ephemeral port and
// inspect/reset in-memory state. Never exposed over the network.
module.exports = {
  app,
  server,
  io,
  rooms,
  privateRoomLockouts,
  PRIVATE_ROOM_BLIP_MS,
  PRIVATE_LOCKOUT_AFTER,
  PRIVATE_LOCKOUT_DURATION_MS,
};
