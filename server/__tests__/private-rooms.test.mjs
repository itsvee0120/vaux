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

describe("private room: probe join", () => {
  it("does not add a member or broadcast join/leave", async () => {
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
    expect(rooms[roomId].members).toHaveLength(1);

    let leaked = false;
    host.on("room:member_joined", () => {
      leaked = true;
    });
    host.on("room:member_left", () => {
      leaked = true;
    });

    const probe = connect();
    await waitForConnect(probe);
    probe.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
      probe: true,
    });
    const res = await once(probe, "room:joined");
    expect(res.probe).toBe(true);
    await probe.disconnect();

    await new Promise((r) => setTimeout(r, 100));
    expect(rooms[roomId].members).toHaveLength(1);
    expect(leaked).toBe(false);

    host.disconnect();
  }, 5000);
});

describe("private room: stale member prune", () => {
  it("drops ghost members on join without member_left", async () => {
    const roomId = freshRoomId();
    const proof = freshAuthProof();
    const staleId = "00000000-0000-0000-0000-000000000099";

    const host = connect();
    await waitForConnect(host);
    host.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
      create: true,
    });
    await once(host, "room:joined");
    rooms[roomId].members.push({
      userId: staleId,
      usernameCipher: freshCipher(),
      role: "listener",
    });

    const guest = connect();
    await waitForConnect(guest);
    let left = false;
    host.on("room:member_left", () => {
      left = true;
    });
    guest.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
    });
    await once(guest, "room:joined");
    expect(left).toBe(false);
    expect(rooms[roomId].members.some((m) => m.userId === staleId)).toBe(false);
    expect(rooms[roomId].members).toHaveLength(2);

    host.disconnect();
    guest.disconnect();
  }, 5000);
});

describe("private room: join lifecycle", () => {
  it("leaves the previous room when the same socket joins another", async () => {
    const roomA = freshRoomId();
    const roomB = freshRoomId();
    const proofA = freshAuthProof();
    const proofB = freshAuthProof();

    const sock = connect();
    await waitForConnect(sock);

    sock.emit("room:join", {
      roomId: roomA,
      username: freshCipher(),
      authProof: proofA,
      create: true,
    });
    await once(sock, "room:joined");
    expect(rooms[roomA].members).toHaveLength(1);

    sock.emit("room:join", {
      roomId: roomB,
      username: freshCipher(),
      authProof: proofB,
      create: true,
    });
    await once(sock, "room:joined");

    expect(rooms[roomA].members).toHaveLength(0);
    expect(rooms[roomB].members).toHaveLength(1);

    sock.disconnect();
  }, 5000);

  it("updates usernameCipher when the same userId rejoins the same room", async () => {
    const roomId = freshRoomId();
    const proof = freshAuthProof();
    const cipher1 = { ct: "YQ==", nonce: "bm9uY2U=" };
    const cipher2 = { ct: "Yg==", nonce: "bm9uY2U=" };

    const sock = connect();
    await waitForConnect(sock);

    sock.emit("room:join", {
      roomId,
      username: cipher1,
      authProof: proof,
      create: true,
    });
    const first = await once(sock, "room:joined");
    expect(first.userId).toBeTruthy();
    expect(rooms[roomId].members[0].usernameCipher).toEqual(cipher1);

    sock.emit("room:join", {
      roomId,
      username: cipher2,
      authProof: proof,
    });
    await once(sock, "room:joined");

    expect(rooms[roomId].members).toHaveLength(1);
    expect(rooms[roomId].members[0].usernameCipher).toEqual(cipher2);

    sock.disconnect();
  }, 5000);
});

describe("private room: joined-room authz", () => {
  it("rejects chat:send to a room the socket did not join", async () => {
    const roomA = freshRoomId();
    const roomB = freshRoomId();
    const proofA = freshAuthProof();
    const proofB = freshAuthProof();

    const a = connect();
    const b = connect();
    await waitForConnect(a);
    await waitForConnect(b);

    a.emit("room:join", {
      roomId: roomA,
      username: freshCipher(),
      authProof: proofA,
      create: true,
    });
    await once(a, "room:joined");

    b.emit("room:join", {
      roomId: roomB,
      username: freshCipher(),
      authProof: proofB,
      create: true,
    });
    await once(b, "room:joined");

    let leaked = false;
    a.on("chat:message", () => {
      leaked = true;
    });

    b.emit("chat:send", {
      roomId: roomA,
      ct: "ZHVtbXk=",
      nonce: "bm9uY2U=",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);

    a.disconnect();
    b.disconnect();
  }, 5000);
});

describe("private room: host transfer then host disconnects", () => {
  it("emits member_left once for the leaving host", async () => {
    const roomId = freshRoomId();
    const proofA = freshAuthProof();
    const proofB = freshAuthProof();

    // hostA creates the room.
    const hostA = connect();
    await waitForConnect(hostA);
    hostA.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proofA,
      create: true,
    });
    const joinedA = await once(hostA, "room:joined");
    const hostAUserId = joinedA.userId;

    // hostB joins with the same invite material (same auth proof).
    const hostB = connect();
    await waitForConnect(hostB);
    hostB.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proofA,
    });
    const joinedB = await once(hostB, "room:joined");
    const hostBUserId = joinedB.userId;

    const leftUserIds = [];
    hostB.on("room:member_left", (d) => {
      leftUserIds.push(d.userId);
    });

    hostA.emit("host:transfer", { roomId, newHostId: hostBUserId });
    // Ensure role transfer happens before we disconnect the old host.
    await once(hostB, "host:changed");

    hostA.disconnect();

    await new Promise((r) => setTimeout(r, 100));
    const count = leftUserIds.filter((id) => id === hostAUserId).length;
    expect(count).toBe(1);
    expect(leftUserIds).toHaveLength(1);

    hostB.disconnect();
  }, 5000);
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
    expect(rooms[roomId]).toBeTruthy();

    const listener = connect();
    await waitForConnect(listener);
    listener.emit("room:join", {
      roomId,
      username: freshCipher(),
      authProof: proof,
    });
    await once(listener, "room:joined");

    const endedPromise = once(listener, "room:ended");
    host.emit("room:destroy", { roomId });
    const ended = await endedPromise;
    expect(ended.reason).toBe("host_left_without_transfer");

    // Per spec the burn is immediate — give a tick for the handler to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms[roomId]).toBeUndefined();

    host.disconnect();
    listener.disconnect();
  }, 5000);
});
