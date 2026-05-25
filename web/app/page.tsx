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
} from "@/lib/session";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL;
// Public dev gate — matches server DEFAULT_API_KEY; override via NEXT_PUBLIC_API_KEY.
const DEFAULT_API_KEY = "vaux-02187xdsx-4335";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || DEFAULT_API_KEY;

function joinSocketRoom(roomId: string, username: string) {
  const socket = getSocket();
  // Server assigns userId on connection; client only sends its display name.
  // Anything else would be ignored by the server.
  const payload = { roomId, username };
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
  /** Our server-assigned userId. Source of truth for "is this me" checks. */
  const myUserIdRef = useRef("");
  /** Set when joinRoom emits room:join so the session rejoin effect does not emit again. */
  const skipSessionRejoinRef = useRef(false);

  const restoring =
    hydrated && session !== null && screen === "lobby" && !rejoinFailed;

  useEffect(() => {
    const socket = getSocket();

    socket.on(
      "room:joined",
      ({
        userId,
        queue,
        playbackState,
        role,
        members: initialMembers,
      }: {
        userId?: string;
        queue: Track[];
        playbackState?: PlaybackState;
        role: string;
        members?: { userId: string; username: string; role: string }[];
      }) => {
        myUserIdRef.current = userId ?? "";
        const stored = loadSession();
        if (stored) {
          setRoomId(stored.roomId);
          setUsername(stored.username);
        }
        setQueue(queue);
        setPlayback(playbackState ?? EMPTY_PLAYBACK);
        setIsHost(role === "host");
        setMembers(initialMembers ?? []);
        setScreen("room");
        setRejoinFailed(false);
      },
    );

    socket.on("room:member_joined", ({ userId, username: joinedUsername }) => {
      setMembers((prev) =>
        prev.find((m) => m.userId === userId)
          ? prev
          : [...prev, { userId, username: joinedUsername, role: "listener" }],
      );
      setMessages((p) => [
        ...p,
        { username: "", text: `${joinedUsername} joined`, system: true },
      ]);
    });

    socket.on("room:member_left", ({ userId }) => {
      setMembers((prev) => {
        const name = prev.find((m) => m.userId === userId)?.username ?? userId;
        setMessages((p) => [
          ...p,
          { username: "", text: `${name} left`, system: true },
        ]);
        return prev.filter((m) => m.userId !== userId);
      });
    });

    socket.on("host:changed", ({ newHostId, newHostUsername }) => {
      // Compare against the server-assigned userId, not username — two users
      // can share a display name, but only one userId matches ours.
      setIsHost(
        Boolean(myUserIdRef.current) && newHostId === myUserIdRef.current,
      );
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          role: m.userId === newHostId ? "host" : "listener",
        })),
      );
      const name = newHostUsername ?? newHostId;
      setMessages((p) => [
        ...p,
        { username: "", text: `⭐ ${name} is now host`, system: true },
      ]);
    });

    socket.on("queue:updated", ({ queue }) => setQueue(queue));
    socket.on("playback:state", (state: PlaybackState) => setPlayback(state));
    socket.on(
      "chat:message",
      ({
        userId: msgUserId,
        username: msgUsername,
        text,
      }: {
        userId?: string;
        username: string;
        text: string;
      }) => {
        setMessages((p) => [
          ...p,
          { userId: msgUserId, username: msgUsername, text },
        ]);
      },
    );

    return () => {
      socket.off("room:joined");
      socket.off("room:member_joined");
      socket.off("room:member_left");
      socket.off("host:changed");
      socket.off("queue:updated");
      socket.off("playback:state");
      socket.off("chat:message");
    };
  }, []);

  useEffect(() => {
    if (!session || screen !== "lobby" || rejoinFailed) return;

    if (skipSessionRejoinRef.current) {
      skipSessionRejoinRef.current = false;
      return;
    }

    joinSocketRoom(session.roomId, session.username);
    const timeout = setTimeout(() => setRejoinFailed(true), 12_000);
    return () => clearTimeout(timeout);
  }, [session, screen, rejoinFailed]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const emitPlay = useCallback(
    (positionSeconds: number) => {
      getSocket().emit("playback:play", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitPause = useCallback(
    (positionSeconds: number) => {
      getSocket().emit("playback:pause", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitSeek = useCallback(
    (positionSeconds: number) => {
      getSocket().emit("playback:seek", { roomId, positionSeconds });
    },
    [roomId],
  );

  const emitEnded = useCallback(() => {
    getSocket().emit("playback:ended", { roomId });
  }, [roomId]);

  function joinRoom(roomIdOverride?: string) {
    const rid = (roomIdOverride ?? roomId).trim();
    const user = username.trim();
    if (!rid || !user) return;

    setRoomId(rid);
    setUsername(user);
    setRejoinFailed(false);
    skipSessionRejoinRef.current = true;
    saveSession(rid, user);
    joinSocketRoom(rid, user);
  }

  async function searchYouTube() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    const res = await fetch(
      `${SERVER}/youtube/search?q=${encodeURIComponent(searchQuery)}`,
      {
        headers: {
          "x-api-key": API_KEY,
        },
      },
    );
    const data = await res.json();
    setSearchResults(data.results || []);
    setSearching(false);
  }

  function addToQueue(result: SearchResult) {
    getSocket().emit("queue:add", { roomId, ...result });
    setSearchResults([]);
    setSearchQuery("");
  }

  function vote(itemId: string, value: 1 | -1) {
    const track = queue.find((t) => t.id === itemId);
    if (value === -1 && (track?.votes ?? 0) < 1) return;
    getSocket().emit("queue:vote", { roomId, itemId, value });
  }

  function playTrack(track: Track) {
    if (!isHost) return;
    getSocket().emit("playback:play_track", { roomId, itemId: track.id });
  }

  function removeFromQueue(itemId: string) {
    if (!isHost) return;
    getSocket().emit("queue:remove", { roomId, itemId });
  }

  function sendChat() {
    if (!chatInput.trim()) return;
    // Server stamps userId + username from the socket session. Client cannot
    // forge sender identity.
    getSocket().emit("chat:send", {
      roomId,
      text: chatInput,
    });
    setChatInput("");
  }

  function transferHost(newHostId: string) {
    getSocket().emit("host:transfer", { roomId, newHostId });
  }

  function leaveRoom() {
    clearSession();
    const socket = getSocket();
    if (socket.connected) socket.disconnect();
    myUserIdRef.current = "";
    setScreen("lobby");
    setRoomId("");
    setRejoinFailed(false);
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
        <p className="text-sm">
          {restoring ? "Rejoining room…" : "Loading…"}
        </p>
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
      />
    );
  }

  return (
    <LobbyPage
      roomId={roomId}
      username={username}
      members={members}
      onTransferHost={transferHost}
      onLeave={leaveRoom}
      isHost={isHost}
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
