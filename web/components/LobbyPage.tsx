"use client";

import { useState } from "react";
import type { PlaybackState } from "@/lib/playback";
import { getSyncedPosition } from "@/lib/playback";
import { decodeHTML } from "@/lib/decode-html";
import type { Track, Message, SearchResult } from "@/lib/room-types";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import Image from "next/image";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  CirclePlus,
  Play,
  SendHorizontal,
  Loader2,
  Users,
  ChevronDownIcon,
  LogOut,
} from "lucide-react";

type LobbyPageProps = {
  roomId: string;
  username: string;
  members: { userId: string; username: string; role: string }[];
  onTransferHost: (userId: string) => void;
  onLeave: () => void;
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
  members,
  onTransferHost,
  onLeave,
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
      <div className="flex items-center gap-3 border-b border-vaux-green px-6 py-3">
        <button
          type="button"
          onClick={onLeave}
          className="cursor-pointer text-lg font-bold text-vaux-green transition-colors hover:text-vaux-light"
          title="Leave room"
        >
          vaux
        </button>
        <span className="text-zinc-600">/</span>
        <span className="text-sm text-vaux-green-dark">{roomId}</span>
        <span className="ml-auto text-xs text-vaux-green-dark">
          {isHost ? "host" : "listener"} · {username}
        </span>
        <button
          type="button"
          onClick={onLeave}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-vaux-green-dark px-2.5 py-1 text-xs text-vaux-green transition-colors hover:border-vaux-green hover:bg-vaux-green-dark/30 hover:text-vaux-light"
          title="Leave room"
        >
          <LogOut className="size-3.5" aria-hidden />
          leave
        </button>
      </div>

      {/* Video Components Start Here */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="overflow-hidden rounded-lg border border-vaux-green-dark bg-zinc-900">
            {playback.videoId ? (
              <>
                <YoutubePlayer
                  playback={playback}
                  isHost={isHost}
                  onPlay={onPlay}
                  onPause={onPause}
                  onEnded={onEnded}
                />
                <div className="border-t border-vaux-green-dark px-4 py-3">
                  <p className="truncate text-sm font-bold text-vaux-light">
                    {decodeHTML(nowPlaying!.title)}
                  </p>
                  <p className="text-xs text-vaux-green">
                    {nowPlaying!.channel}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {isHost && (
                      <>
                        <button
                          type="button"
                          className="rounded bg-vaux-bg-dark border-vaux-green-dark border-1 px-3 py-2 text-xs text-vaux-light hover:bg-vaux-green-dark cursor-pointer"
                          onClick={() =>
                            playback.isPlaying
                              ? onPause(syncedPosition)
                              : onPlay(syncedPosition)
                          }
                        >
                          {playback.isPlaying ? "pause" : "play"}
                        </button>
                        <button
                          type="button"
                          className="rounded bg-vaux-bg-dark border-vaux-green-dark border-1 px-3 py-2 text-xs text-vaux-light hover:bg-vaux-green-dark cursor-pointer"
                          onClick={onEnded}
                          title="Skip track"
                        >
                          skip ▶
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={600}
                          step={0.5}
                          value={seekValue}
                          className="flex-1 rounded-full h-1 appearance-none transition-all outline-none cursor-pointer focus:outline-none
                          [&::-webkit-slider-runnable-track]:bg-vaux-light/20
                          [&::-webkit-slider-runnable-track]:rounded-full
                          [&::-webkit-slider-runnable-track]:cursor-pointer
                          [&::-webkit-slider-runnable-track]:transition-all
                          [&::-webkit-slider-runnable-track]:appearance-none
                          [&::-webkit-slider-runnable-track]:border-1
                          [&::-webkit-slider-runnable-track]:border-vaux-green
                          [&::-webkit-slider-thumb]:appearance-none 
                          [&::-webkit-slider-thumb]:w-4
                          [&::-webkit-slider-thumb]:h-4
                          [&::-webkit-slider-thumb]:bg-vaux-bg-dark
                          [&::-webkit-slider-thumb]:rounded-full
                          [&::-webkit-slider-thumb]:shadow-lg
                          [&::-webkit-slider-thumb]:transition-all
                          [&::-webkit-slider-thumb]:border-2
                          [&::-webkit-slider-thumb]:border-vaux-green-dark 
                          [&::-webkit-slider-thumb]:hover:scale-110
                          [&::-webkit-slider-thumb]:active:scale-100
                          [&::-moz-range-thumb]:appearance-none
                          [&::-moz-range-thumb]:w-5
                          [&::-moz-range-thumb]:h-5
                          [&::-moz-range-thumb]:bg-vaux-green
                          [&::-moz-range-thumb]:rounded-full
                          [&::-moz-range-thumb]:border-2
                          [&::-moz-range-thumb]:border-vaux-green"
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
                        <span className="w-10 text-right text-xs tabular-nums text-vaux-light">
                          {Math.floor(seekValue)}s
                        </span>
                      </>
                    )}
                  </div>
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

          {/* Search/ Result & add Tracks Components Start Here */}
          <div>
            <div className="mb-3 flex gap-2">
              <input
                className="flex-1 rounded border border-vaux-green-dark/40 bg-zinc-900 px-3 py-2 text-sm focus:border-vaux-green focus:outline-none"
                placeholder="search youtube..."
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSearch()}
              />
              <button
                onClick={onSearch}
                disabled={searching}
                className="flex items-center justify-center gap-2 rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-vaux-green-dark cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {searching ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Searching
                  </>
                ) : (
                  "Search"
                )}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="flex flex-col gap-2">
                {searchResults.map((r) => (
                  <div
                    key={r.videoId}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-vaux-green hover:bg-vaux-bg-dark p-2 transition-colors hover:border-vaux-green"
                    onClick={() => onAddToQueue(r)}
                  >
                    <div className="relative h-14 w-20 shrink-0">
                      <Image
                        src={r.thumbnail}
                        alt=""
                        fill
                        sizes="80px"
                        className="rounded object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-vaux-light">
                        {decodeHTML(r.title)}
                      </p>
                      <p className="text-xs text-vaux-green">{r.channel}</p>
                    </div>
                    <span className="shrink-0 cursor-pointer rounded-full p-1 text-vaux-green-dark hover:text-vaux-green transition-colors inline-flex items-center justify-center">
                      <CirclePlus size={25} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Queue Components Start Here */}
        <div className="flex min-h-0 w-full shrink-0 flex-col border-t border-vaux-green lg:w-80 lg:border-t-0 lg:border-l">
          {/* Host Components Start Here */}
          {isHost && members.filter((m) => m.role !== "host").length > 0 && (
            <div className="border-b border-vaux-green-dark p-3">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-2 text-xs uppercase tracking-widest text-vaux-green hover:text-vaux-light cursor-pointer w-full">
                  <Users size={12} />
                  listeners ({members.filter((m) => m.role !== "host").length})
                  <ChevronDownIcon className="ml-auto" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="bg-zinc-900 border border-vaux-green-dark p-2 flex flex-col gap-1 min-w-48"
                  align="start"
                >
                  {members
                    .filter((m) => m.role !== "host")
                    .map((m) => (
                      <div
                        key={m.userId}
                        className="flex items-center justify-between px-1 py-1"
                      >
                        <span className="text-xs text-vaux-light">
                          {m.username}
                        </span>
                        <button
                          onClick={() => onTransferHost(m.userId)}
                          className="text-xs text-vaux-green-dark hover:text-vaux-green cursor-pointer transition-colors"
                        >
                          make host
                        </button>
                      </div>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-2 text-xs uppercase tracking-widest text-vaux-green">
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
                    <div className="relative h-9 w-12">
                      <Image
                        src={track.thumbnail}
                        alt=""
                        fill
                        sizes="48px"
                        className="rounded object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-vaux-light ">
                        {decodeHTML(track.title)}
                      </p>
                      <p className="truncate text-xs text-vaux-green">
                        {track.addedBy}
                      </p>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <button
                        onClick={() => onVote(track.id, 1)}
                        className="text-xs text-zinc-500 hover:text-vaux-green cursor-pointer"
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
                        className="text-xs text-zinc-500 hover:text-[#C44545] cursor-pointer"
                      >
                        ▼
                      </button>
                    </div>
                    {isHost && (
                      <button
                        onClick={() => onPlayTrack(track)}
                        className="ml-1 cursor-pointer text-xs font-bold text-vaux-green-dark transition-transform hover:scale-115 hover:text-[#A2CB8B]"
                        title="Play now (host)"
                      >
                        <Play size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Chat Components Start Here */}
          <div className="flex h-60 flex-col border-t border-vaux-green-dark">
            <p className="mb-1 px-3 pt-2 text-xs uppercase tracking-widest text-vaux-green">
              chat
            </p>
            <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3">
              {messages.map((m, i) => (
                <div key={i} className="text-xs">
                  {m.system ? (
                    <span className="italic text-zinc-600">{m.text}</span>
                  ) : (
                    <>
                      <span className="text-vaux-green">{m.username}: </span>
                      <span className="text-vaux-light">{m.text}</span>
                    </>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2 p-2">
              <input
                className="flex-1 rounded border border-vaux-green-dark bg-zinc-900 px-2 py-1 text-xs focus:border-vaux-light focus:outline-none"
                placeholder="say something..."
                value={chatInput}
                onChange={(e) => onChatInputChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSendChat()}
              />
              <button
                className="rounded bg-vaux-green-dark px-3 py-2 text-xs hover:bg-vaux-green cursor-pointer transition-colors"
                onClick={onSendChat}
              >
                <SendHorizontal size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
