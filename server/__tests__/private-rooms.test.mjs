// Integration tests for private-room server behavior — exercises the real
// socket.io stack on an ephemeral port. Tests cover the three properties
// that aren't observable from the client crypto pin alone:
//   1. Lockout after PRIVATE_LOCKOUT_AFTER failed auth attempts.
//   2. Blip-TTL cleanup after the last private member leaves.
//   3. room:destroy is host-only.
//
// We import index.js as a module — its boot code is gated behind
// require.main === module, so the import won't call .listen() or run
// yt-dlp setup. Tests drive listen(0) themselves and reset module-level
// state per test to keep them order-independent.
//
// Env setup (PRIVATE_ROOM_BLIP_MS=200, etc.) lives in vitest.config.mjs —
// ES module imports are hoisted, so setting process.env inside this file
// would happen AFTER index.js has already read the original values.

import crypto from "node:crypto";
import { io as ioClient } from "socket.io-client";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

// Server is CommonJS — interop default import gives us the module.exports.
import serverModule from "../index.js";
const {
  server,
  io,
  rooms,
  privateRoomLockouts,
  PRIVATE_ROOM_BLIP_MS,
  PRIVATE_LOCKOUT_AFTER,
} = serverModule;

let baseUrl;

const freshAuthProof = () => crypto.randomBytes(32).toString("base64");
const freshRoomId = () => crypto.randomBytes(16).toString("base64url");
// Server only validates shape; never decrypts. Any short strings pass.
const freshCipher = () => ({ ct: "ZHVtbXk=", nonce: "bm9uY2U=" });

const connect = () =>
  ioClient(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });

const once = (socket, event, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const waitForConnect = (socket) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 2000);
    socket.once("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  io.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  // Fresh state per test — keeps tests order-independent and prevents
  // bleed-over from lockout entries or stale rooms.
  for (const key of Object.keys(rooms)) delete rooms[key];
  privateRoomLockouts.clear();
});

describe("private room: blip TTL cleanup", () => {
  it(
    "deletes the room after PRIVATE_ROOM_BLIP_MS when last member leaves",
    async () => {
      const roomId = freshRoomId();
      const sock = connect();
      await waitForConnect(sock);

      sock.emit("room:join", {
        roomId,
        username: freshCipher(),
        authProof: freshAuthProof(),
        create: true,
      });
      await once(sock, "room:joined");
      expect(rooms[roomId]).toBeTruthy();
      expect(rooms[roomId].private).toBe(true);

      sock.disconnect();

      // Room still present immediately — blip is the whole point of the timer.
      expect(rooms[roomId]).toBeTruthy();

      await new Promise((r) => setTimeout(r, PRIVATE_ROOM_BLIP_MS + 100));
      expect(rooms[roomId]).toBeUndefined();
    },
    5000,
  );
});

describe("private room: lockout after repeated wrong passwords", () => {
  it(
    "emits { reason: 'locked' } after PRIVATE_LOCKOUT_AFTER failed attempts",
    async () => {
      const roomId = freshRoomId();
      const correctProof = freshAuthProof();

      // Seed the room with the correct authHash via a real create flow.
      const host = connect();
      await waitForConnect(host);
      host.emit("room:join", {
        roomId,
        username: freshCipher(),
        authProof: correctProof,
        create: true,
      });
      await once(host, "room:joined");

      // PRIVATE_LOCKOUT_AFTER failed attempts using a NEW socket per try —
      // joinLimiter is per-socket (5 / 30 s), so reusing one socket would
      // stall after the 5th attempt and never reach the lockout threshold.
      for (let i = 0; i < PRIVATE_LOCKOUT_AFTER; i++) {
        const probe = connect();
        await waitForConnect(probe);
        probe.emit("room:join", {
          roomId,
          username: freshCipher(),
          authProof: freshAuthProof(), // wrong
        });
        const failed = await once(probe, "room:join_failed");
        expect(failed.reason).toBe("auth_failed");
        probe.disconnect();
      }

      // (N+1)th attempt should now be locked, not just auth_failed.
      const probe = connect();
      await waitForConnect(probe);
      probe.emit("room:join", {
        roomId,
        username: freshCipher(),
        authProof: freshAuthProof(),
      });
      const locked = await once(probe, "room:join_failed");
      expect(locked.reason).toBe("locked");
      expect(typeof locked.retryAfterMs).toBe("number");
      expect(locked.retryAfterMs).toBeGreaterThan(0);
      probe.disconnect();
      host.disconnect();

      const entry = privateRoomLockouts.get(roomId);
      expect(entry).toBeTruthy();
      expect(entry.lockedUntil).toBeGreaterThan(Date.now());
    },
    20000,
  );
});

describe("private room: room:destroy authz", () => {
  it("non-host emit does not delete the room", async () => {
    const roomId = freshRoomId();
    const proof = freshAuthProof();

    const host = connect();
    await waitForConnect(host);
    host.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
      create: true,
    });
    await once(host, "room:joined");

    const guest = connect();
    await waitForConnect(guest);
    guest.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
    });
    await once(guest, "room:joined");

    expect(rooms[roomId]).toBeTruthy();
    expect(rooms[roomId].members.length).toBe(2);

    guest.emit("room:destroy", { roomId });

    // Give the server an event-loop tick to (not) act.
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms[roomId]).toBeTruthy();

    host.disconnect();
    guest.disconnect();
  }, 5000);

  it("host emit deletes the room immediately", async () => {
    const roomId = freshRoomId();
    const host = connect();
    await waitForConnect(host);
    host.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: freshAuthProof(),
      create: true,
    });
    await once(host, "room:joined");
    expect(rooms[roomId]).toBeTruthy();

    host.emit("room:destroy", { roomId });

    // Per spec the burn is immediate — give a tick for the handler to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms[roomId]).toBeUndefined();

    host.disconnect();
  }, 5000);
});
