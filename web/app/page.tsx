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

/** Must match server `API_KEY` / CLI `VAUX_API_KEY` default when env is unset. */
const DEFAULT_API_KEY = "vaux-02187xdsx-4335";

function joinSocketRoom(roomId: string, username: string) {
  const socket = getSocket();
  const payload = { roomId, userId: username, username };
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
  const usernameRef = useRef(username);

  const restoring =
    hydrated && session !== null && screen === "lobby" && !rejoinFailed;

  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  useEffect(() => {
    const socket = getSocket();

    socket.on(
      "room:joined",
      ({ queue, playbackState, role, members: initialMembers }) => {
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
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      setMessages((p) => [
        ...p,
        { username: "", text: `${userId} left`, system: true },
      ]);
    });

    socket.on("host:changed", ({ newHostId }) => {
      setIsHost(newHostId === usernameRef.current);
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          role: m.userId === newHostId ? "host" : "listener",
        })),
      );
    });

    socket.on("queue:updated", ({ queue }) => setQueue(queue));
    socket.on("playback:state", (state: PlaybackState) => setPlayback(state));
    socket.on("chat:message", ({ username: msgUsername, text }) => {
      setMessages((p) => [...p, { username: msgUsername, text }]);
    });

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

    joinSocketRoom(session.roomId, session.username);
    const timeout = setTimeout(() => setRejoinFailed(true), 12_000);
    return () => clearTimeout(timeout);
  }, [session, screen, rejoinFailed]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
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

  function joinRoom() {
    const rid = roomId.trim();
    const user = username.trim();
    if (!rid || !user) return;

    setRoomId(rid);
    setUsername(user);
    setRejoinFailed(false);
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
          "x-api-key": process.env.NEXT_PUBLIC_API_KEY || DEFAULT_API_KEY,
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

  function sendChat() {
    if (!chatInput.trim()) return;
    getSocket().emit("chat:send", {
      roomId,
      userId: username,
      username,
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
      onSendChat={sendChat}
      onPlay={emitPlay}
      onPause={emitPause}
      onSeek={emitSeek}
      onEnded={emitEnded}
    />
  );
}
