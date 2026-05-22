"use client";

import { useState } from "react";
import type { PlaybackState } from "@/lib/playback";
import { getSyncedPosition } from "@/lib/playback";
import { decodeHTML } from "@/lib/decode-html";
import type { Track, Message, SearchResult } from "@/lib/room-types";
import { YoutubePlayer } from "@/components/YoutubePlayer";

type LobbyPageProps = {
  roomId: string;
  username: string;
  isHost: boolean;
  queue: Track[];
  messages: Message[];
  playback: PlaybackState;
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;
  chatInput: string;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  onSearchQueryChange: (value: string) => void;
  onChatInputChange: (value: string) => void;
  onSearch: () => void;
  onAddToQueue: (result: SearchResult) => void;
  onVote: (itemId: string, value: 1 | -1) => void;
  onPlayTrack: (track: Track) => void;
  onSendChat: () => void;
  onPlay: (positionSeconds: number) => void;
  onPause: (positionSeconds: number) => void;
  onSeek: (positionSeconds: number) => void;
  onEnded: () => void;
};

export function LobbyPage({
  roomId,
  username,
  isHost,
  queue,
  messages,
  playback,
  searchQuery,
  searchResults,
  searching,
  chatInput,
  chatEndRef,
  onSearchQueryChange,
  onChatInputChange,
  onSearch,
  onAddToQueue,
  onVote,
  onPlayTrack,
  onSendChat,
  onPlay,
  onPause,
  onSeek,
  onEnded,
}: LobbyPageProps) {
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekUi, setSeekUi] = useState(0);
  const syncedPosition = getSyncedPosition(playback);
  const seekValue = isSeeking ? seekUi : syncedPosition;

  const nowPlaying = playback.videoId
    ? {
        videoId: playback.videoId,
        title: playback.title ?? "",
        channel: playback.channel ?? "",
        thumbnail: playback.thumbnail ?? "",
      }
    : null;

  return (
    <main className="flex min-h-dvh w-full flex-col bg-black font-mono text-white">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-3">
        <span className="text-lg font-bold text-violet-400">vaux</span>
        <span className="text-zinc-600">/</span>
        <span className="text-sm text-zinc-300">{roomId}</span>
        <span className="ml-auto text-xs text-zinc-600">
          {isHost ? "host" : "listener"} · {username}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            {playback.videoId ? (
              <>
                <YoutubePlayer
                  playback={playback}
                  isHost={isHost}
                  onPlay={onPlay}
                  onPause={onPause}
                  onEnded={onEnded}
                />
                <div className="border-t border-zinc-800 px-4 py-3">
                  <p className="truncate text-sm font-bold text-white">
                    {decodeHTML(nowPlaying!.title)}
                  </p>
                  <p className="text-xs text-zinc-500">{nowPlaying!.channel}</p>
                  {isHost && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700"
                        onClick={() =>
                          playback.isPlaying
                            ? onPause(syncedPosition)
                            : onPlay(syncedPosition)
                        }
                      >
                        {playback.isPlaying ? "pause" : "play"}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={600}
                        step={0.5}
                        value={seekValue}
                        className="flex-1 accent-violet-500"
                        onPointerDown={() => {
                          setIsSeeking(true);
                          setSeekUi(syncedPosition);
                        }}
                        onChange={(e) => setSeekUi(Number(e.target.value))}
                        onPointerUp={(e) => {
                          onSeek(Number(e.currentTarget.value));
                          setIsSeeking(false);
                        }}
                      />
                      <span className="w-10 text-right text-xs tabular-nums text-zinc-500">
                        {Math.floor(seekValue)}s
                      </span>
                    </div>
                  )}
                  {!isHost && playback.isPlaying && (
                    <p className="mt-2 text-xs text-zinc-600">
                      synced · {Math.floor(syncedPosition)}s
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-48 items-center justify-center text-sm text-zinc-600">
                no track playing —{" "}
                {isHost ? "press ▶ on a queue track" : "waiting for host"}
              </div>
            )}
          </div>

          <div>
            <div className="mb-3 flex gap-2">
              <input
                className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
                placeholder="search youtube..."
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSearch()}
              />
              <button
                className="rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                onClick={onSearch}
              >
                {searching ? "..." : "search"}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="flex flex-col gap-2">
                {searchResults.map((r) => (
                  <div
                    key={r.videoId}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-2 transition-colors hover:border-violet-600"
                    onClick={() => onAddToQueue(r)}
                  >
                    <img
                      src={r.thumbnail}
                      alt=""
                      className="h-14 w-20 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-white">
                        {decodeHTML(r.title)}
                      </p>
                      <p className="text-xs text-zinc-500">{r.channel}</p>
                    </div>
                    <span className="shrink-0 text-xs text-violet-400">
                      + add
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 w-full shrink-0 flex-col border-t border-zinc-800 lg:w-80 lg:border-t-0 lg:border-l">
          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">
              queue
            </p>
            {queue.length === 0 ? (
              <p className="text-xs text-zinc-700">
                empty — search and add tracks
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {queue.map((track) => (
                  <div
                    key={track.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2"
                  >
                    <img
                      src={track.thumbnail}
                      alt=""
                      className="h-9 w-12 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-white">
                        {decodeHTML(track.title)}
                      </p>
                      <p className="truncate text-xs text-zinc-600">
                        {track.addedBy}
                      </p>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <button
                        onClick={() => onVote(track.id, 1)}
                        className="text-xs text-zinc-500 hover:text-violet-400"
                      >
                        ▲
                      </button>
                      <span className="text-xs text-zinc-400">
                        {track.votes}
                      </span>
                      <button
                        onClick={() => onVote(track.id, -1)}
                        disabled={track.votes < 1}
                        title={
                          track.votes < 1
                            ? "You need at least 1 vote to downvote a track"
                            : undefined
                        }
                        className="text-xs text-zinc-500 hover:text-red-400"
                      >
                        ▼
                      </button>
                    </div>
                    {isHost && (
                      <button
                        onClick={() => onPlayTrack(track)}
                        className="ml-1 text-xs text-violet-500 hover:text-violet-300"
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

          <div className="flex h-56 flex-col border-t border-zinc-800">
            <p className="mb-1 px-3 pt-2 text-xs uppercase tracking-widest text-zinc-500">
              chat
            </p>
            <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3">
              {messages.map((m, i) => (
                <div key={i} className="text-xs">
                  {m.system ? (
                    <span className="italic text-zinc-600">{m.text}</span>
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
                className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs focus:border-violet-500 focus:outline-none"
                placeholder="say something..."
                value={chatInput}
                onChange={(e) => onChatInputChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSendChat()}
              />
              <button
                className="rounded bg-violet-600 px-3 py-1 text-xs hover:bg-violet-500"
                onClick={onSendChat}
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
