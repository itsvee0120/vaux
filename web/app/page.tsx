"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { getSocket } from "@/lib/socket";
import {
  type PlaybackState,
  EMPTY_PLAYBACK,
  getSyncedPosition,
} from "@/lib/playback";
import { YoutubePlayer } from "@/components/YoutubePlayer";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL;

type Track = {
  id: string;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  votes: number;
  addedBy: string;
};

type Message = {
  username: string;
  text: string;
  system?: boolean;
};

type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
};

function decodeHTML(str: string) {
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

// ── Home ──
// Main client: lobby join flow, then room UI with synced player, queue, and chat.
export default function Home() {
  const [screen, setScreen] = useState<"lobby" | "room">("lobby");
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>(EMPTY_PLAYBACK);
  const [seekUi, setSeekUi] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  // ── socket listeners ──
  // Subscribes once on mount; room:joined switches to room screen with playback snapshot.
  useEffect(() => {
    const socket = getSocket();
    socket.on("connect", () => {});
    socket.on("room:joined", ({ queue, playbackState, role }) => {
      setQueue(queue);
      setPlayback(playbackState ?? EMPTY_PLAYBACK);
      setIsHost(role === "host");
      setScreen("room");
    });
    socket.on("room:member_joined", ({ username }) => {
      setMessages((p) => [
        ...p,
        { username: "", text: `${username} joined`, system: true },
      ]);
    });
    socket.on("room:member_left", ({ userId }) => {
      setMessages((p) => [
        ...p,
        { username: "", text: `${userId} left`, system: true },
      ]);
    });
    socket.on("queue:updated", ({ queue }) => setQueue(queue));
    socket.on("playback:state", (state: PlaybackState) => {
      setPlayback(state);
    });
    socket.on("chat:message", ({ username, text }) => {
      setMessages((p) => [...p, { username, text }]);
    });
    return () => {
      socket.off("connect");
      socket.off("room:joined");
      socket.off("room:member_joined");
      socket.off("room:member_left");
      socket.off("queue:updated");
      socket.off("playback:state");
      socket.off("chat:message");
    };
  }, []);

  useEffect(() => {
    setSeekUi(getSyncedPosition(playback));
  }, [playback]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const emitPlay = useCallback((positionSeconds: number) => {
    getSocket().emit("playback:play", {
      roomId: roomIdRef.current,
      positionSeconds,
    });
  }, []);

  const emitPause = useCallback((positionSeconds: number) => {
    getSocket().emit("playback:pause", {
      roomId: roomIdRef.current,
      positionSeconds,
    });
  }, []);

  const emitSeek = useCallback((positionSeconds: number) => {
    getSocket().emit("playback:seek", {
      roomId: roomIdRef.current,
      positionSeconds,
    });
  }, []);

  const emitEnded = useCallback(() => {
    getSocket().emit("playback:ended", { roomId: roomIdRef.current });
  }, []);

  // ── joinRoom ──
  // Connects socket and joins room; server assigns host to first member.
  function joinRoom() {
    if (!roomId.trim() || !username.trim()) return;
    const socket = getSocket();
    socket.connect();
    socket.emit("room:join", { roomId, userId: username, username });
  }

  // ── searchYouTube ──
  // Proxied search via server /youtube/search (keeps API key off the client).
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
    const socket = getSocket();
    socket.emit("queue:add", { roomId, ...result });
    setSearchResults([]);
    setSearchQuery("");
  }

  function vote(itemId: string, value: 1 | -1) {
    const socket = getSocket();
    socket.emit("queue:vote", { roomId, itemId, value });
  }

  // ── playTrack ──
  // Host-only: removes item from queue server-side and broadcasts playback:state.
  function playTrack(track: Track) {
    if (!isHost) return;
    getSocket().emit("playback:play_track", { roomId, itemId: track.id });
  }

  function sendChat() {
    if (!chatInput.trim()) return;
    const socket = getSocket();
    socket.emit("chat:send", {
      roomId,
      userId: username,
      username,
      text: chatInput,
    });
    setChatInput("");
  }

  const nowPlaying = playback.videoId
    ? {
        videoId: playback.videoId,
        title: playback.title ?? "",
        channel: playback.channel ?? "",
        thumbnail: playback.thumbnail ?? "",
      }
    : null;

  if (screen === "lobby") {
    return (
      <main className="min-h-screen w-full min-w-[17rem] bg-black text-white flex items-center justify-center font-mono p-4 sm:p-8 box-border overflow-x-auto">
        <div className="flex flex-col gap-4 w-full max-w-sm min-w-0">
          <h1 className="text-3xl font-bold text-violet-400 mb-2">vaux</h1>
          <p className="text-zinc-500 text-sm -mt-2">
            listen together, in sync
          </p>
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
            placeholder="room name (e.g. indie-night)"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
          />
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
            placeholder="your name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
          />
          <button
            className="bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all rounded px-4 py-2 text-sm font-bold"
            onClick={joinRoom}
          >
            join room →
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen w-full bg-black text-white font-mono flex flex-col">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <span className="text-violet-400 font-bold text-lg">vaux</span>
        <span className="text-zinc-600">/</span>
        <span className="text-zinc-300 text-sm">{roomId}</span>
        <span className="ml-auto text-zinc-600 text-xs">
          {isHost ? "host" : "listener"} · {username}
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden flex-col lg:flex-row min-h-0">
        <div className="flex flex-col flex-1 min-w-0 p-4 gap-4 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            {playback.videoId ? (
              <>
                <YoutubePlayer
                  playback={playback}
                  isHost={isHost}
                  onPlay={emitPlay}
                  onPause={emitPause}
                  onEnded={emitEnded}
                />
                <div className="px-4 py-3 border-t border-zinc-800">
                  <p className="text-sm font-bold text-white truncate">
                    {decodeHTML(nowPlaying!.title)}
                  </p>
                  <p className="text-xs text-zinc-500">{nowPlaying!.channel}</p>
                  {isHost && (
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        type="button"
                        className="text-xs bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1"
                        onClick={() =>
                          playback.isPlaying
                            ? emitPause(getSyncedPosition(playback))
                            : emitPlay(getSyncedPosition(playback))
                        }
                      >
                        {playback.isPlaying ? "pause" : "play"}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={600}
                        step={0.5}
                        value={seekUi}
                        className="flex-1 accent-violet-500"
                        onChange={(e) => setSeekUi(Number(e.target.value))}
                        onMouseUp={() => emitSeek(seekUi)}
                        onTouchEnd={() => emitSeek(seekUi)}
                      />
                      <span className="text-xs text-zinc-500 tabular-nums w-10 text-right">
                        {Math.floor(seekUi)}s
                      </span>
                    </div>
                  )}
                  {!isHost && playback.isPlaying && (
                    <p className="text-xs text-zinc-600 mt-2">
                      synced · {Math.floor(getSyncedPosition(playback))}s
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">
                no track playing —{" "}
                {isHost ? "press ▶ on a queue track" : "waiting for host"}
              </div>
            )}
          </div>

          <div>
            <div className="flex gap-2 mb-3">
              <input
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
                placeholder="search youtube..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchYouTube()}
              />
              <button
                className="bg-zinc-800 hover:bg-zinc-700 rounded px-4 py-2 text-sm"
                onClick={searchYouTube}
              >
                {searching ? "..." : "search"}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="flex flex-col gap-2">
                {searchResults.map((r) => (
                  <div
                    key={r.videoId}
                    className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg p-2 hover:border-violet-600 transition-colors cursor-pointer"
                    onClick={() => addToQueue(r)}
                  >
                    <img
                      src={r.thumbnail}
                      alt=""
                      className="w-20 h-14 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {decodeHTML(r.title)}
                      </p>
                      <p className="text-xs text-zinc-500">{r.channel}</p>
                    </div>
                    <span className="text-violet-400 text-xs shrink-0">
                      + add
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-3">
            <p className="text-xs text-zinc-500 mb-2 uppercase tracking-widest">
              queue
            </p>
            {queue.length === 0 ? (
              <p className="text-zinc-700 text-xs">
                empty — search and add tracks
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {queue.map((track) => (
                  <div
                    key={track.id}
                    className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg p-2"
                  >
                    <img
                      src={track.thumbnail}
                      alt=""
                      className="w-12 h-9 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">
                        {decodeHTML(track.title)}
                      </p>
                      <p className="text-xs text-zinc-600 truncate">
                        {track.addedBy}
                      </p>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <button
                        onClick={() => vote(track.id, 1)}
                        className="text-zinc-500 hover:text-violet-400 text-xs"
                      >
                        ▲
                      </button>
                      <span className="text-xs text-zinc-400">
                        {track.votes}
                      </span>
                      <button
                        onClick={() => vote(track.id, -1)}
                        className="text-zinc-500 hover:text-red-400 text-xs"
                      >
                        ▼
                      </button>
                    </div>
                    {isHost && (
                      <button
                        onClick={() => playTrack(track)}
                        className="text-xs text-violet-500 hover:text-violet-300 ml-1"
                        title="Play now (host)"
                      >
                        ▶
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-zinc-800 flex flex-col h-56">
            <p className="text-xs text-zinc-500 px-3 pt-2 mb-1 uppercase tracking-widest">
              chat
            </p>
            <div className="flex-1 overflow-y-auto px-3 flex flex-col gap-1">
              {messages.map((m, i) => (
                <div key={i} className="text-xs">
                  {m.system ? (
                    <span className="text-zinc-600 italic">{m.text}</span>
                  ) : (
                    <>
                      <span className="text-violet-400">{m.username}: </span>
                      <span className="text-zinc-300">{m.text}</span>
                    </>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2 p-2">
              <input
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-violet-500"
                placeholder="say something..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
              />
              <button
                className="bg-violet-600 hover:bg-violet-500 rounded px-3 py-1 text-xs"
                onClick={sendChat}
              >
                →
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
