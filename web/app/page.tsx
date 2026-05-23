"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { getSocket } from "@/lib/socket";
import { type PlaybackState, EMPTY_PLAYBACK } from "@/lib/playback";
import type { Track, Message, SearchResult } from "@/lib/room-types";
import { LoginPage } from "@/components/LoginPage";
import { LobbyPage } from "@/components/LobbyPage";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL;

// ── Home ──
// Orchestrates login (join) and lobby (room) screens; socket state lives here.
export default function Home() {
  const [screen, setScreen] = useState<"lobby" | "room">("lobby");
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
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
  useEffect(() => {
    usernameRef.current = username;
  }, [username]);
  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => {});

    socket.on(
      "room:joined",
      ({ queue, playbackState, role, members: initialMembers }) => {
        setQueue(queue);
        setPlayback(playbackState ?? EMPTY_PLAYBACK);
        setIsHost(role === "host");
        setMembers(initialMembers ?? []);
        setScreen("room");
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
      setIsHost(newHostId === username);
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          role: m.userId === newHostId ? "host" : "listener",
        })),
      );
    });

    socket.on("queue:updated", ({ queue }) => setQueue(queue));

    socket.on("playback:state", (state: PlaybackState) => {
      setPlayback(state);
    });

    socket.on("chat:message", ({ username: msgUsername, text }) => {
      setMessages((p) => [...p, { username: msgUsername, text }]);
    });

    return () => {
      socket.off("connect");
      socket.off("room:joined");
      socket.off("room:member_joined");
      socket.off("room:member_left");
      socket.off("host:changed");
      socket.off("queue:updated");
      socket.off("playback:state");
      socket.off("chat:message");
    };
  }, [username]);

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
    if (!roomId.trim() || !username.trim()) return;
    const socket = getSocket();
    socket.connect();
    socket.emit("room:join", { roomId, userId: username, username });
  }

  async function searchYouTube() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    const res = await fetch(
      `${SERVER}/youtube/search?q=${encodeURIComponent(searchQuery)}`,
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

  if (screen === "lobby") {
    return (
      <LoginPage
        roomId={roomId}
        username={username}
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
