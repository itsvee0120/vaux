"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import { getSocket } from "@/lib/socket";
import { type PlaybackState, EMPTY_PLAYBACK } from "@/lib/playback";
import type { Track, Message, SearchResult } from "@/lib/room-types";
import { LoginPage } from "@/components/LoginPage";
import { LobbyPage } from "@/components/LobbyPage";
import {
  clearSession,
  getSessionSnapshot,
  loadSession,
  saveSession,
  subscribeSession,
  type PrivateSessionMaterial,
} from "@/lib/session";
import {
  authProofToB64,
  b64ToBytes,
  bytesToB64,
  decryptChat,
  deriveRoomMaterial,
  encryptChat,
  isWellFormedPassword,
} from "@/lib/crypto";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL;
const DEFAULT_API_KEY = "vaux-02187xdsx-4335";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || DEFAULT_API_KEY;

type UsernameCipher = { ct: string; nonce: string };

type PrivateMaterial = {
  roomId: string;
  /** chatKey lives in memory only after derivation; never serialized to disk. */
  chatKey: Uint8Array;
  authProof: Uint8Array;
  /** Plaintext password — only set immediately after derivation, before reload. */
  password: string | null;
  /** Our own username encrypted under chatKey. Reused for every send. */
  ownNameCipher: UsernameCipher;
};

function joinSocketPublic(roomId: string, username: string) {
  const socket = getSocket();
  const payload = { roomId, username };
  if (socket.connected) {
    socket.emit("room:join", payload);
  } else {
    socket.connect();
    socket.once("connect", () => socket.emit("room:join", payload));
  }
}

function joinSocketPrivate(
  roomId: string,
  authProof: Uint8Array,
  usernameCipher: UsernameCipher,
  create: boolean,
) {
  const socket = getSocket();
  const payload = {
    roomId,
    username: usernameCipher,
    authProof: authProofToB64(authProof),
    create,
  };
  if (socket.connected) {
    socket.emit("room:join", payload);
  } else {
    socket.connect();
    socket.once("connect", () => socket.emit("room:join", payload));
  }
}

function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function useStoredSession() {
  return useSyncExternalStore(
    subscribeSession,
    getSessionSnapshot,
    () => null,
  );
}

export default function Home() {
  const hydrated = useHydrated();
  const session = useStoredSession();
  const [screen, setScreen] = useState<"lobby" | "room">("lobby");
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const [rejoinFailed, setRejoinFailed] = useState(false);
  /** True only while the mount-time session-restore effect is actively
   *  trying to reconnect a *previous* session — never for a fresh,
   *  user-initiated join. Gates the full-screen "Rejoining room…" overlay. */
  const [autoRejoining, setAutoRejoining] = useState(false);
  /** True while a user-initiated join (from the login form) is in flight. */
  const [joining, setJoining] = useState(false);
  const [members, setMembers] = useState<
    { userId: string; username: string; role: string }[]
  >([]);
  const [isHost, setIsHost] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>(EMPTY_PLAYBACK);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const myUserIdRef = useRef("");
  const skipSessionRejoinRef = useRef(false);

  const [isPrivate, setIsPrivate] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** Render-safe mirrors of myUserIdRef / privateRef.current.password —
   *  reading a ref's `.current` during render throws (React refs rule), so
   *  these are updated alongside every ref write and used in JSX instead. */
  const [displayUserId, setDisplayUserId] = useState("");
  const [displayPrivatePassword, setDisplayPrivatePassword] = useState<
    string | null
  >(null);
  /**
   * Active private-room key material. Refs (not state) so encrypt/decrypt
   * helpers see the latest values without re-binding to socket handlers.
   */
  const privateRef = useRef<PrivateMaterial | null>(null);
  /** Decrypted username lookup by userId — used by chat:message to render
   *  sender names from server-omitted private chat payloads. */
  const memberNamesRef = useRef<Map<string, string>>(new Map());
  /** Prevent duplicate "X left" system log spam. */
  const leftAnnouncedRef = useRef<Map<string, number>>(new Map());
  const roomEndedRef = useRef(false);
  const disconnectWarnedRef = useRef(false);

  const restoring =
    hydrated && autoRejoining && screen === "lobby" && !rejoinFailed;

  // URL fragment parsing now lives in LoginPage's lazy state initializers
  // so an opened invite link pre-fills before the user sees anything.
  // page.tsx only sees a finished `joinPrivateRoom({ password, create })`
  // call from the LoginPage submit handler.

  // ── Helpers for private-room en/decrypt ──

  const decryptName = useCallback(
    async (cipher: UsernameCipher | undefined): Promise<string | null> => {
      const material = privateRef.current;
      if (!material || !cipher) return null;
      return decryptChat(material.chatKey, cipher.ct, cipher.nonce);
    },
    [],
  );

  // ── Socket event handlers ──

  useEffect(() => {
    const socket = getSocket();

    type JoinedPayload = {
      userId?: string;
      queue: Track[];
      playbackState?: PlaybackState;
      role: string;
      private?: boolean;
      members?: Array<{
        userId: string;
        username?: string;
        usernameCipher?: UsernameCipher;
        role: string;
      }>;
    };

    socket.on("room:joined", (payload: JoinedPayload) => {
      const {
        userId,
        queue: q,
        playbackState,
        role,
        members: initialMembers,
      } = payload;
      const isPriv = payload.private === true;
      myUserIdRef.current = userId ?? "";
      setDisplayUserId(userId ?? "");
      const stored = loadSession();
      if (stored) {
        setRoomId(stored.roomId);
        setUsername(stored.username);
      }
      setQueue(q);
      setPlayback(playbackState ?? EMPTY_PLAYBACK);
      setIsHost(role === "host");
      setIsPrivate(isPriv);
      roomEndedRef.current = false;
      disconnectWarnedRef.current = false;
      setAutoRejoining(false);
      setJoining(false);

      if (isPriv) {
        // Decrypt every member's name before showing the room. Any member
        // whose cipher fails to decrypt (corrupted or sent before our key
        // was ready) renders as "(unknown)" — server can't help us here.
        void (async () => {
          const decrypted: typeof members = [];
          const lookup = new Map<string, string>();
          for (const m of initialMembers ?? []) {
            const name = (await decryptName(m.usernameCipher)) ?? "(unknown)";
            lookup.set(m.userId, name);
            decrypted.push({
              userId: m.userId,
              username: name,
              role: m.role,
            });
          }
          memberNamesRef.current = lookup;
          leftAnnouncedRef.current.clear();
          setMembers(decrypted);
          setScreen("room");
          setRejoinFailed(false);
        })();
      } else {
        setMembers(
          (initialMembers ?? []).map((m) => ({
            userId: m.userId,
            username: m.username ?? "",
            role: m.role,
          })),
        );
        leftAnnouncedRef.current.clear();
        setScreen("room");
        setRejoinFailed(false);
      }
    });

    socket.on(
      "room:member_joined",
      ({
        userId,
        username: joinedUsername,
        usernameCipher,
      }: {
        userId: string;
        username?: string;
        usernameCipher?: UsernameCipher;
      }) => {
        void (async () => {
          const name = usernameCipher
            ? ((await decryptName(usernameCipher)) ?? "(unknown)")
            : (joinedUsername ?? "");
          if (usernameCipher) memberNamesRef.current.set(userId, name);
          let announceJoin = false;
          setMembers((prev) => {
            if (prev.some((m) => m.userId === userId)) {
              return prev.map((m) =>
                m.userId === userId ? { ...m, username: name } : m,
              );
            }
            announceJoin = true;
            return [...prev, { userId, username: name, role: "listener" }];
          });
          if (announceJoin) {
            setMessages((p) => [
              ...p,
              { username: "", text: `${name} joined`, system: true },
            ]);
          }
        })();
      },
    );

    socket.on("room:member_left", ({ userId }: { userId: string }) => {
      setMembers((prev) => {
        const now = Date.now();
        const last = leftAnnouncedRef.current.get(userId);
        if (last && now - last < 10_000) return prev;

        const left = prev.find((m) => m.userId === userId);
        if (!left) return prev;
        leftAnnouncedRef.current.set(userId, now);
        memberNamesRef.current.delete(userId);
        setMessages((p) => [
          ...p,
          { username: "", text: `${left.username} left`, system: true },
        ]);
        return prev.filter((m) => m.userId !== userId);
      });
    });

    socket.on(
      "host:changed",
      ({
        newHostId,
        newHostUsername,
        newHostUsernameCipher,
      }: {
        newHostId: string;
        newHostUsername?: string;
        newHostUsernameCipher?: UsernameCipher;
      }) => {
        setIsHost(
          Boolean(myUserIdRef.current) && newHostId === myUserIdRef.current,
        );
        setMembers((prev) =>
          prev.map((m) => ({
            ...m,
            role: m.userId === newHostId ? "host" : "listener",
          })),
        );
        void (async () => {
          let name: string | undefined = newHostUsername;
          if (newHostUsernameCipher) {
            name =
              (await decryptName(newHostUsernameCipher)) ??
              memberNamesRef.current.get(newHostId) ??
              "(unknown)";
          }
          setMessages((p) => [
            ...p,
            {
              username: "",
              text: `⭐ ${name ?? newHostId} is now host`,
              system: true,
            },
          ]);
        })();
      },
    );

    socket.on("queue:updated", ({ queue: q }: { queue: Track[] }) =>
      setQueue(q),
    );
    socket.on("playback:state", (state: PlaybackState) => setPlayback(state));
    socket.on(
      "room:ended",
      ({ reason }: { reason?: string }) => {
        roomEndedRef.current = true;
        const msg =
          reason === "host_left_without_transfer"
            ? "Host left without transfer — room closed."
            : "Room closed.";
        setMessages((p) => [...p, { username: "", text: msg, system: true }]);
        setJoinError(msg);
        setTimeout(() => {
          const socket = getSocket();
          if (socket.connected) socket.disconnect();
          clearSession();
          privateRef.current = null;
          setDisplayPrivatePassword(null);
          memberNamesRef.current = new Map();
          myUserIdRef.current = "";
          setDisplayUserId("");
          setScreen("lobby");
          setRoomId("");
          setIsPrivate(false);
          setQueue([]);
          setMembers([]);
          setPlayback(EMPTY_PLAYBACK);
          setIsHost(false);
        }, 300);
      },
    );

    socket.on(
      "chat:message",
      ({
        userId: msgUserId,
        username: msgUsername,
        text,
        ct,
        nonce,
      }: {
        userId?: string;
        username?: string;
        text?: string;
        ct?: string;
        nonce?: string;
      }) => {
        const isPrivateMsg = typeof ct === "string" && typeof nonce === "string";
        if (!isPrivateMsg) {
          setMessages((p) => [
            ...p,
            {
              userId: msgUserId,
              username: msgUsername ?? "",
              text: text ?? "",
            },
          ]);
          return;
        }
        const material = privateRef.current;
        if (!material) return;
        void (async () => {
          const plain = await decryptChat(material.chatKey, ct, nonce);
          if (plain == null) {
            setMessages((p) => [
              ...p,
              {
                username: "",
                text: "could not decrypt message",
                system: true,
              },
            ]);
            return;
          }
          const senderName =
            msgUserId != null ? memberNamesRef.current.get(msgUserId) : null;
          setMessages((p) => [
            ...p,
            {
              userId: msgUserId,
              username: senderName ?? "(unknown)",
              text: plain,
            },
          ]);
        })();
      },
    );

    socket.on("chat:rate_limited", () => {
      setMessages((p) => [
        ...p,
        { username: "", text: "slow down — too many messages", system: true },
      ]);
    });

    socket.on("queue:full", ({ max }: { max: number }) => {
      setMessages((p) => [
        ...p,
        {
          username: "",
          text: `queue is full (max ${max} tracks)`,
          system: true,
        },
      ]);
    });

    socket.on(
      "room:join_failed",
      ({ reason, retryAfterMs }: { reason: string; retryAfterMs?: number }) => {
        clearSession();
        privateRef.current = null;
        setDisplayPrivatePassword(null);
        memberNamesRef.current = new Map();
        setIsPrivate(false);
        setRejoinFailed(true);
        setAutoRejoining(false);
        setJoining(false);
        setScreen("lobby");
        if (reason === "auth_failed") {
          setJoinError(
            "Could not join — wrong password, or this room no longer exists.",
          );
        } else if (reason === "locked") {
          const sec = Math.ceil((retryAfterMs ?? 60_000) / 1000);
          setJoinError(`Too many wrong attempts. Try again in ${sec}s.`);
        } else if (reason === "room full") {
          setJoinError("Room is full.");
        } else {
          setJoinError(`Could not join (${reason}).`);
        }
        console.warn(`[vaux] join failed: ${reason}`);
      },
    );

    return () => {
      socket.off("room:joined");
      socket.off("room:member_joined");
      socket.off("room:member_left");
      socket.off("host:changed");
      socket.off("queue:updated");
      socket.off("playback:state");
      socket.off("room:ended");
      socket.off("chat:message");
      socket.off("chat:rate_limited");
      socket.off("queue:full");
      socket.off("room:join_failed");
    };
  }, [decryptName]);

  // ── Session-restore rejoin ──
  useEffect(() => {
    if (!session || screen !== "lobby" || rejoinFailed) return;
    if (skipSessionRejoinRef.current) {
      skipSessionRejoinRef.current = false;
      return;
    }

    setAutoRejoining(true);

    if (session.privateMaterial) {
      // Private rooms reload from sessionStorage by re-encrypting our own
      // username (we still have chatKey) and re-emitting room:join. The
      // password itself was discarded after derivation so we can't show
      // the invite URL — but rejoin still works.
      const material = session.privateMaterial;
      void (async () => {
        const chatKey = b64ToBytes(material.chatKeyB64);
        const authProof = b64ToBytes(material.authProofB64);
        const ownNameCipher = await encryptChat(chatKey, session.username);
        privateRef.current = {
          roomId: session.roomId,
          chatKey,
          authProof,
          password: null,
          ownNameCipher,
        };
        setDisplayPrivatePassword(null);
        setIsPrivate(true);
        joinSocketPrivate(session.roomId, authProof, ownNameCipher, false);
      })();
    } else {
      joinSocketPublic(session.roomId, session.username);
    }

    const timeout = setTimeout(() => {
      setRejoinFailed(true);
      setAutoRejoining(false);
    }, 12_000);
    return () => clearTimeout(timeout);
  }, [session, screen, rejoinFailed]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const emitPlay = useCallback(
    (positionSeconds: number) => {
      if (roomEndedRef.current) return;
      if (!getSocket().connected) return;
      getSocket().emit("playback:play", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitPause = useCallback(
    (positionSeconds: number) => {
      if (roomEndedRef.current) return;
      if (!getSocket().connected) return;
      getSocket().emit("playback:pause", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitSeek = useCallback(
    (positionSeconds: number) => {
      if (roomEndedRef.current) return;
      if (!getSocket().connected) return;
      getSocket().emit("playback:seek", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitEnded = useCallback(() => {
    if (roomEndedRef.current) return;
    if (!getSocket().connected) return;
    getSocket().emit("playback:ended", { roomId });
  }, [roomId]);

  function canEmitRoomAction(): boolean {
    if (roomEndedRef.current) return false;
    const socket = getSocket();
    if (socket.connected) return true;
    if (!disconnectWarnedRef.current) {
      disconnectWarnedRef.current = true;
      setMessages((p) => [
        ...p,
        {
          username: "",
          text: "Disconnected from room — please rejoin.",
          system: true,
        },
      ]);
    }
    return false;
  }

  function joinRoom(roomIdOverride?: string) {
    const rid = (roomIdOverride ?? roomId).trim();
    const user = username.trim();
    if (!rid || !user) return;
    setRoomId(rid);
    setUsername(user);
    setRejoinFailed(false);
    setJoinError(null);
    setIsPrivate(false);
    setJoining(true);
    privateRef.current = null;
    setDisplayPrivatePassword(null);
    skipSessionRejoinRef.current = true;
    saveSession(rid, user);
    joinSocketPublic(rid, user);
  }

  async function joinPrivateRoom({
    password,
    create,
  }: {
    password: string;
    create: boolean;
  }) {
    const user = username.trim();
    if (!user) return;
    if (!isWellFormedPassword(password)) {
      setJoinError("Invalid invite code.");
      return;
    }
    setJoinError(null);
    setRejoinFailed(false);
    setIsPrivate(true);
    setJoining(true);

    // Argon2id derivation. Spec budget is ~250 ms; keep the user informed
    // by showing "Rejoining room…" overlay via the existing `restoring`
    // path — for now we just block, since the LoginPage submit is sync.
    try {
      const material = await deriveRoomMaterial(password);
      const ownNameCipher = await encryptChat(material.chatKey, user);
      privateRef.current = {
        roomId: material.roomId,
        chatKey: material.chatKey,
        authProof: material.authProof,
        password,
        ownNameCipher,
      };
      setDisplayPrivatePassword(password);
      const persisted: PrivateSessionMaterial = {
        authProofB64: bytesToB64(material.authProof),
        chatKeyB64: bytesToB64(material.chatKey),
      };
      setRoomId(material.roomId);
      skipSessionRejoinRef.current = true;
      saveSession(material.roomId, user, persisted);
      joinSocketPrivate(material.roomId, material.authProof, ownNameCipher, create);
    } catch (err) {
      console.warn("[vaux] private join derivation failed:", err);
      setJoinError("Could not derive room key. Check the invite and try again.");
      setIsPrivate(false);
      setJoining(false);
      privateRef.current = null;
      setDisplayPrivatePassword(null);
    }
  }

  async function searchYouTube() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    const res = await fetch(
      `${SERVER}/youtube/search?q=${encodeURIComponent(searchQuery)}`,
      { headers: { "x-api-key": API_KEY } },
    );
    const data = await res.json();
    setSearchResults(data.results || []);
    setSearching(false);
  }

  function addToQueue(result: SearchResult) {
    if (!canEmitRoomAction()) return;
    getSocket().emit("queue:add", { roomId, ...result });
    setSearchResults([]);
    setSearchQuery("");
  }

  function vote(itemId: string, value: 1 | -1) {
    if (!canEmitRoomAction()) return;
    const track = queue.find((t) => t.id === itemId);
    if (value === -1 && (track?.votes ?? 0) < 1) return;
    getSocket().emit("queue:vote", { roomId, itemId, value });
  }

  function playTrack(track: Track) {
    if (!canEmitRoomAction()) return;
    if (!isHost) return;
    getSocket().emit("playback:play_track", { roomId, itemId: track.id });
  }

  function removeFromQueue(itemId: string) {
    if (!canEmitRoomAction()) return;
    if (!isHost) return;
    getSocket().emit("queue:remove", { roomId, itemId });
  }

  function sendChat() {
    if (!canEmitRoomAction()) return;
    const text = chatInput.trim();
    if (!text) return;
    const material = privateRef.current;
    if (isPrivate && material) {
      void (async () => {
        const { ct, nonce } = await encryptChat(material.chatKey, text);
        getSocket().emit("chat:send", { roomId, ct, nonce });
        // Echo our own message locally — server doesn't loop us back any
        // differently than other members, but the chat:message handler
        // looks up senderName from members; rely on that.
      })();
    } else {
      getSocket().emit("chat:send", { roomId, text });
    }
    setChatInput("");
  }

  function transferHost(newHostId: string) {
    if (!canEmitRoomAction()) return;
    getSocket().emit("host:transfer", { roomId, newHostId });
  }

  function leaveRoom() {
    const socket = getSocket();
    // Host of a private room: burn it before disconnecting so other members
    // don't get a 5-second blip-tolerance window where they could rejoin.
    if (isPrivate && isHost && socket.connected) {
      socket.emit("room:destroy", { roomId });
    }
    clearSession();
    if (socket.connected) socket.disconnect();
    myUserIdRef.current = "";
    setDisplayUserId("");
    privateRef.current = null;
    setDisplayPrivatePassword(null);
    memberNamesRef.current = new Map();
    setScreen("lobby");
    setRoomId("");
    setRejoinFailed(false);
    setAutoRejoining(false);
    setJoining(false);
    setJoinError(null);
    setIsPrivate(false);
    setQueue([]);
    setMessages([]);
    setMembers([]);
    setPlayback(EMPTY_PLAYBACK);
    setIsHost(false);
    setSearchQuery("");
    setSearchResults([]);
  }

  const loginRoomId = session?.roomId ?? roomId;
  const loginUsername = session?.username ?? username;

  if (!hydrated || restoring) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-black font-mono text-vaux-green">
        <p className="text-sm">{restoring ? "Rejoining room…" : "Loading…"}</p>
      </main>
    );
  }

  if (screen === "lobby") {
    return (
      <LoginPage
        roomId={loginRoomId}
        username={loginUsername}
        onRoomIdChange={setRoomId}
        onUsernameChange={setUsername}
        onJoin={joinRoom}
        onJoinPrivate={joinPrivateRoom}
        joinError={joinError}
        joining={joining}
      />
    );
  }

  return (
    <LobbyPage
      roomId={roomId}
      username={username}
      userId={displayUserId}
      members={members}
      onTransferHost={transferHost}
      onLeave={leaveRoom}
      isHost={isHost}
      isPrivate={isPrivate}
      privatePassword={displayPrivatePassword}
      queue={queue}
      messages={messages}
      playback={playback}
      searchQuery={searchQuery}
      searchResults={searchResults}
      searching={searching}
      chatInput={chatInput}
      chatEndRef={chatEndRef}
      onSearchQueryChange={setSearchQuery}
      onChatInputChange={setChatInput}
      onSearch={searchYouTube}
      onAddToQueue={addToQueue}
      onVote={vote}
      onPlayTrack={playTrack}
      onRemoveFromQueue={removeFromQueue}
      onSendChat={sendChat}
      onPlay={emitPlay}
      onPause={emitPause}
      onSeek={emitSeek}
      onEnded={emitEnded}
    />
  );
}
