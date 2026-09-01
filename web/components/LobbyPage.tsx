"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import type { PlaybackState } from "@/lib/playback";
import { getSyncedPosition } from "@/lib/playback";
import { decodeHTML } from "@/lib/decode-html";
import type { Track, Message, SearchResult } from "@/lib/room-types";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import Image from "next/image";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import {
  CirclePlus,
  Play,
  Trash2,
  SendHorizontal,
  Loader2,
  Users,
  ChevronDownIcon,
  LogOut,
  Bug,
  CircleHelp,
  Tv2,
  Search as SearchIcon,
  ListMusic,
  MessageSquare,
  Lock,
  Share2,
  Ratio,
} from "lucide-react";

type Tab = "player" | "search" | "queue" | "chat";
import { BUG_REPORT_URL } from "@/lib/links";
import { HelpModal } from "@/components/HelpModal";
import { MobileTabBar, type MobileTab } from "@/components/MobileTabBar";
import { hasSeenHelp, markHelpSeen } from "@/lib/help-storage";
import {
  ASPECT_RATIO_PRESETS,
  setPlayerAspectRatio,
  setRatioMenuCollapsed,
  useStoredPlayerAspectRatio,
  useStoredRatioMenuCollapsed,
  type AspectRatioId,
} from "@/lib/player-ratio-storage";

// Thin, draggable divider between resizable panels — a hairline that grows
// into a visible grip on hover/drag so it doesn't clutter the UI at rest.
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  const isRow = direction === "horizontal";
  return (
    <PanelResizeHandle
      className={`group relative shrink-0 bg-vaux-green/20 outline-none transition-colors hover:bg-vaux-green-dark data-[resize-handle-active]:bg-vaux-green ${
        isRow ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
      }`}
    >
      <div
        className={`pointer-events-none absolute rounded-full bg-vaux-green-dark opacity-0 transition-opacity group-hover:opacity-100 group-data-[resize-handle-active]:opacity-100 ${
          isRow
            ? "left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2"
        }`}
      />
    </PanelResizeHandle>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Stable per-user palette. userId is hashed deterministically and the hash
// matches the CLI's (sum of char codes mod palette length) so the same person
// gets the same color across both clients. Two users sharing a display name
// still render in distinguishable colors.
const CHAT_COLORS = [
  "#52d4a0",
  "#f0c54f",
  "#7ec8e3",
  "#e07fc4",
  "#ff8a5b",
  "#a685e2",
] as const;

function colorForUser(userId: string | undefined): string {
  if (!userId) return CHAT_COLORS[0];
  let sum = 0;
  for (let i = 0; i < userId.length; i++) sum += userId.charCodeAt(i);
  return CHAT_COLORS[sum % CHAT_COLORS.length];
}

type LobbyPageProps = {
  roomId: string;
  username: string;
  userId: string;
  members: { userId: string; username: string; role: string }[];
  onTransferHost: (userId: string) => void;
  onLeave: () => void;
  isHost: boolean;
  isPrivate?: boolean;
  /** Plaintext password for reconstructing the invite URL on copy. Lost on
   *  reload (per spec) — null means "show 'private room' but copy is unavailable". */
  privatePassword?: string | null;
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
  onRemoveFromQueue: (itemId: string) => void;
  onSendChat: () => void;
  onPlay: (positionSeconds: number) => void;
  onPause: (positionSeconds: number) => void;
  onSeek: (positionSeconds: number) => void;
  onEnded: () => void;
};

export function LobbyPage({
  roomId,
  username,
  userId,
  members,
  onTransferHost,
  onLeave,
  isHost,
  isPrivate = false,
  privatePassword = null,
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
  onRemoveFromQueue,
  onSendChat,
  onPlay,
  onPause,
  onSeek,
  onEnded,
}: LobbyPageProps) {
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekUi, setSeekUi] = useState(0);
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("player");
  // Per-viewer video-frame shape. storedRatio is hydration-safe (SSR/first
  // client render both see the default); overrideRatio takes over the
  // instant the user picks a preset this session, without waiting on a
  // storage round-trip.
  const storedRatio = useStoredPlayerAspectRatio();
  const [overrideRatio, setOverrideRatio] = useState<AspectRatioId | null>(
    null,
  );
  const playerRatio = overrideRatio ?? storedRatio;
  const handleRatioChange = useCallback((id: AspectRatioId) => {
    setOverrideRatio(id);
    setPlayerAspectRatio(id);
  }, []);
  // The preset row is tucked behind a disclosure toggle so it doesn't eat
  // vertical space once someone's picked a shape and moved on.
  const storedRatioMenuCollapsed = useStoredRatioMenuCollapsed();
  const [ratioMenuOverride, setRatioMenuOverride] = useState<boolean | null>(
    null,
  );
  const ratioMenuCollapsed = ratioMenuOverride ?? storedRatioMenuCollapsed;
  const toggleRatioMenu = useCallback(() => {
    setRatioMenuOverride((prev) => {
      const next = !(prev ?? storedRatioMenuCollapsed);
      setRatioMenuCollapsed(next);
      return next;
    });
  }, [storedRatioMenuCollapsed]);
  // Resolve a queue item's display name. Public rooms have plaintext
  // `addedBy`. Private rooms omit it (server doesn't know plaintext
  // usernames) and clients map `addedById` against the locally-decrypted
  // member list. Falls back to a generic placeholder if the member left
  // before this client received their member_joined event.
  const nameForAddedBy = useCallback((track: Track): string => {
    if (track.addedBy) return track.addedBy;
    if (track.addedById) {
      const member = members.find((m) => m.userId === track.addedById);
      if (member?.username) return member.username;
    }
    return "anon";
  }, [members]);
  // Track viewport so we can render exactly one layout tree instead of two.
  // Rendering both via Tailwind hidden/lg:flex would double-mount the
  // YoutubePlayer (real YT.Player instance) and the chatEndRef — both must be
  // singletons. Defaults to false (mobile) so SSR matches the small-screen
  // shell; flips on first client effect via matchMedia.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // --- Mobile-only notifications ---------------------------------------
  // Three things compete for attention on mobile (where panels are tabbed
  // instead of all on-screen): tracks added to the queue, new chat
  // messages, and host transfers. Strategy:
  //   1. Unread badges on Queue/Chat tabs — persistent until the user
  //      opens that tab.
  //   2. Toast notifications via sonner — content preview (who/what)
  //      that fades on its own. Skipped if the user is already on that
  //      tab (the panel is already visible).
  //   3. Auto-switch to the Player tab when this user becomes the host
  //      so the controls are visible immediately.
  // All three are gated by !isDesktop so desktop users see none of it.
  const [lastSeenQueueLen, setLastSeenQueueLen] = useState(0);
  const [lastSeenChatLen, setLastSeenChatLen] = useState(0);
  // Refs track the previous length across renders without retriggering
  // effects, and let us seed `lastSeen*` to the size of the initial
  // socket sync (so the badge starts at 0 instead of "everything is new").
  const prevQueueLenRef = useRef(queue.length);
  const prevMessagesLenRef = useRef(messages.length);
  const prevIsHostRef = useRef(isHost);
  const prevMemberIdsRef = useRef<Set<string>>(new Set());
  const membersInitializedRef = useRef(false);
  // Toasts/badges are disabled for ~1.5s after mount. That window covers
  // the initial socket payload (queue + chat history + host info) so we
  // don't fire a wave of notifications the moment the user joins.
  // Kept in state (not a ref) because we also read it during render to
  // gate the host -> player auto-tab-switch below, and refs can't be
  // accessed during render in React 19.
  const [notificationsReady, setNotificationsReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setNotificationsReady(true);
      setLastSeenQueueLen(prevQueueLenRef.current);
      setLastSeenChatLen(prevMessagesLenRef.current);
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const prev = prevQueueLenRef.current;
    prevQueueLenRef.current = queue.length;
    if (!notificationsReady || isDesktop) return;
    if (queue.length <= prev) return;
    // findLast picks the most recent track that isn't ours, in case a
    // batch arrives at once (e.g. a multi-add or backfill). For private
    // rooms addedBy is undefined; match on addedById against our own
    // userId so we never toast on our own adds.
    const added = queue
      .slice(prev)
      .findLast((t) =>
        t.addedById ? t.addedById !== userId : t.addedBy !== username,
      );
    if (!added) return;
    if (activeTab === "queue") return;
    toast(`🎵 ${nameForAddedBy(added)} added`, {
      description: decodeHTML(added.title),
      action: {
        label: "View",
        onClick: () => setActiveTab("queue"),
      },
    });
  }, [
    queue,
    isDesktop,
    activeTab,
    username,
    notificationsReady,
    userId,
    nameForAddedBy,
  ]);

  useEffect(() => {
    const prev = prevMessagesLenRef.current;
    prevMessagesLenRef.current = messages.length;
    if (!notificationsReady || isDesktop) return;
    if (messages.length <= prev) return;
    const incoming = messages
      .slice(prev)
      .findLast((m) => !m.system && m.username !== username);
    if (!incoming) return;
    if (activeTab === "chat") return;
    toast(`💬 ${incoming.username}`, {
      description: incoming.text,
      action: {
        label: "View",
        onClick: () => setActiveTab("chat"),
      },
    });
  }, [messages, isDesktop, activeTab, username, notificationsReady]);

  useEffect(() => {
    const prev = prevIsHostRef.current;
    prevIsHostRef.current = isHost;
    if (!notificationsReady || isDesktop) return;
    if (prev === isHost) return;
    if (isHost) {
      // Becoming host is the one event important enough to interrupt the
      // current tab — the player controls are now live for this user.
      // The actual tab switch happens via the render-time conditional
      // below (setState in an effect would trip
      // react-hooks/set-state-in-effect).
      toast("👑 You're now the host", {
        description: "Player controls are live for you - view in Queue tab.",
      });
    } else {
      const newHost = members.find((m) => m.role === "host");
      toast(`👑 ${newHost?.username ?? "Someone else"} is now the host`);
    }
  }, [isHost, isDesktop, members, notificationsReady]);

  useEffect(() => {
    if (!notificationsReady) return;
    const prev = prevMemberIdsRef.current;
    if (!membersInitializedRef.current) {
      prevMemberIdsRef.current = new Set(
        members.map((m) => m.userId).filter(Boolean),
      );
      membersInitializedRef.current = true;
      return;
    }
    for (const m of members) {
      if (!m.userId || prev.has(m.userId) || m.userId === userId) continue;
      toast(`👋 ${m.username} joined`, {
        ...(isDesktop
          ? {}
          : {
              action: {
                label: "Chat",
                onClick: () => setActiveTab("chat"),
              },
            }),
      });
    }
    prevMemberIdsRef.current = new Set(
      members.map((m) => m.userId).filter(Boolean),
    );
  }, [members, notificationsReady, userId, isDesktop]);

  // --- Render-time state syncs --------------------------------------
  // The three setState calls below used to live inside useEffects, but
  // react-hooks/set-state-in-effect (new in React 19) forbids that
  // because the resulting cascading commit hurts performance. The
  // recommended replacement is to compare against a previous value
  // stored in state and call setState during render — React detects the
  // pattern, restarts the render in-place, and avoids the extra commit.
  //
  // Auto-switch to the Player tab the moment this user becomes host.
  const [prevHostFlag, setPrevHostFlag] = useState(isHost);
  if (prevHostFlag !== isHost) {
    setPrevHostFlag(isHost);
    if (isHost && !isDesktop && notificationsReady) {
      setActiveTab("player");
    }
  }
  // Reset the unread badge as soon as the user opens that tab (and keep
  // it at 0 while they stay there, even if more items arrive).
  if (
    !isDesktop &&
    activeTab === "queue" &&
    lastSeenQueueLen !== queue.length
  ) {
    setLastSeenQueueLen(queue.length);
  }
  if (
    !isDesktop &&
    activeTab === "chat" &&
    lastSeenChatLen !== messages.length
  ) {
    setLastSeenChatLen(messages.length);
  }

  const queueUnread = !isDesktop
    ? Math.max(0, queue.length - lastSeenQueueLen)
    : 0;
  const chatUnread = !isDesktop
    ? Math.max(0, messages.length - lastSeenChatLen)
    : 0;

  // Auto-open the help modal the first time a user lands in a room. The
  // 1500ms delay lets the player + queue + chat finish their initial render
  // so the modal feels like an intentional welcome rather than a load-time
  // flash. hasSeenHelp() biases to `true` in SSR / locked storage to avoid
  // hydration flicker and to never spam users we can't record dismissal for.
  useEffect(() => {
    if (hasSeenHelp()) return;
    const timer = setTimeout(() => setHelpOpen(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  function handleHelpOpenChange(open: boolean) {
    setHelpOpen(open);
    if (!open) markHelpSeen();
  }
  // Force a re-render twice a second while playing so getSyncedPosition picks
  // up the new wall-clock time and the slider/now-playing labels advance
  // between server broadcasts. Paused or while-the-user-is-dragging: no tick,
  // so the slider sits still and doesn't fight the drag gesture.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playback.isPlaying || isSeeking) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [playback.isPlaying, isSeeking]);
  const syncedPosition = getSyncedPosition(playback);
  const seekValue = isSeeking ? seekUi : syncedPosition;
  const seekMax = playback.duration > 0 ? playback.duration : 600;
  const seekPct = Math.min(100, Math.max(0, (seekValue / seekMax) * 100));

  function handleCopyRoom() {
    if (isPrivate) {
      // Reconstruct the invite URL from the in-memory password. After a
      // tab reload the password is gone (sessionStorage holds derived
      // material only); in that case there's nothing to copy.
      if (!privatePassword || typeof window === "undefined") return;
      navigator.clipboard.writeText(
        `${window.location.origin}/#${privatePassword}`,
      );
    } else {
      navigator.clipboard.writeText(roomId);
    }
    setCopiedRoom(true);
    setTimeout(() => setCopiedRoom(false), 1500);
  }

  // Public rooms only — shares a join link with the room name prefilled
  // (?room=<roomId>, read by LoginPage on load). Private rooms keep their
  // existing password-bearing invite link via handleCopyRoom above.
  async function handleShareRoom() {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Vaux",
          text: `Join me on Vaux — room "${roomId}"`,
          url,
        });
      } catch {
        /* user cancelled the share sheet; ignore */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopiedRoom(true);
      setTimeout(() => setCopiedRoom(false), 1500);
    } catch {
      /* clipboard unavailable; nothing more we can do */
    }
  }

  const nowPlaying = playback.videoId
    ? {
        videoId: playback.videoId,
        title: playback.title ?? "",
        channel: playback.channel ?? "",
        thumbnail: playback.thumbnail ?? "",
      }
    : null;

  // Listeners dropdown lives at the top of the queue panel for both layouts —
  // mobile shows it inside the Queue tab, desktop pins it above the queue list
  // in the right column. Hidden when there are no non-host listeners.
  const listenersDropdown =
    isHost && members.filter((m) => m.role !== "host").length > 0 ? (
      <div className="border-b border-vaux-green-dark p-3">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger className="flex w-full cursor-pointer items-center gap-2 text-xs uppercase tracking-widest text-vaux-green hover:text-vaux-light">
                <Users size={12} />
                View listeners or Transfer Host(
                {members.filter((m) => m.role !== "host").length})
                <ChevronDownIcon className="ml-auto" />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Open listener list — tap `&quot;make host&quot;` to transfer host
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            className="flex min-w-48 flex-col gap-1 border border-vaux-green-dark bg-zinc-900 p-2"
            align="start"
          >
            {members
              .filter((m) => m.role !== "host")
              .map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center justify-between px-1 py-1"
                >
                  <span className="text-xs text-vaux-light">{m.username}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onTransferHost(m.userId)}
                        className="cursor-pointer text-xs text-vaux-green-dark transition-colors hover:text-vaux-green"
                      >
                        make host
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      Pass host control to {m.username} — they can play, pause,
                      skip, and remove tracks
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) : null;

  // Each panel is defined once and rendered by both layouts. The YoutubePlayer
  // wraps a real YT.Player instance — duplicating it across two DOM trees
  // would create competing players, which is why we render one layout at a
  // time (see isDesktop above) instead of using Tailwind hidden/lg:flex.
  const playerPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-vaux-green-dark bg-zinc-900">
      {playback.videoId ? (
        <>
          <div className="min-h-0 flex-1">
            <YoutubePlayer
              playback={playback}
              isHost={isHost}
              suppressHostPlaybackEcho={!isDesktop && activeTab !== "player"}
              aspectRatio={playerRatio}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onEnded}
            />
          </div>
          <div className="shrink-0 overflow-y-auto border-t border-vaux-green-dark px-4 py-3">
            <p className="truncate text-sm font-bold text-vaux-light">
              {decodeHTML(nowPlaying!.title)}
            </p>
            <p className="text-xs text-vaux-green">{nowPlaying!.channel}</p>
            <div className="mt-3">
              <button
                type="button"
                onClick={toggleRatioMenu}
                aria-expanded={!ratioMenuCollapsed}
                className="flex cursor-pointer items-center gap-1.5 text-[11px] uppercase tracking-widest text-zinc-500 transition-colors hover:text-zinc-300"
              >
                <Ratio size={12} />
                frame shape
                <ChevronDownIcon
                  className={`size-3 transition-transform ${
                    ratioMenuCollapsed ? "" : "rotate-180"
                  }`}
                />
              </button>
              {!ratioMenuCollapsed && (
                <div
                  role="group"
                  aria-label="Video frame aspect ratio"
                  className="mt-2 flex gap-1 rounded-xl border border-vaux-green-dark p-1"
                >
                  {ASPECT_RATIO_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleRatioChange(preset.id)}
                      aria-pressed={playerRatio === preset.id}
                      className={`flex-1 cursor-pointer rounded-lg py-1.5 text-[11px] font-bold transition-all ${
                        playerRatio === preset.id
                          ? "bg-vaux-green-dark text-white"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {isHost && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="cursor-pointer rounded border-1 border-vaux-green-dark bg-vaux-bg-dark px-3 py-2 text-xs text-vaux-light hover:bg-vaux-green-dark"
                        onClick={() =>
                          playback.isPlaying
                            ? onPause(syncedPosition)
                            : onPlay(syncedPosition)
                        }
                      >
                        {playback.isPlaying ? "pause" : "play"}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {playback.isPlaying
                        ? "Pause for everyone in the room"
                        : "Resume playback for everyone"}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="cursor-pointer rounded border-1 border-vaux-green-dark bg-vaux-bg-dark px-3 py-2 text-xs text-vaux-light hover:bg-vaux-green-dark"
                        onClick={onEnded}
                      >
                        skip ▶
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Skip to next track in queue
                    </TooltipContent>
                  </Tooltip>
                  <input
                    type="range"
                    min={0}
                    max={seekMax}
                    step={0.5}
                    value={seekValue}
                    style={
                      {
                        "--vaux-progress": `${seekPct}%`,
                      } as React.CSSProperties
                    }
                    className="flex-1 rounded-full h-1 appearance-none transition-all outline-none cursor-pointer focus:outline-none
                    [&::-webkit-slider-runnable-track]:bg-vaux-light/20
                    [&::-webkit-slider-runnable-track]:[background-image:linear-gradient(to_right,var(--color-vaux-green)_var(--vaux-progress),transparent_var(--vaux-progress))]
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
                    [&::-moz-range-track]:h-1
                    [&::-moz-range-track]:rounded-full
                    [&::-moz-range-track]:bg-vaux-light/20
                    [&::-moz-range-progress]:h-1
                    [&::-moz-range-progress]:rounded-full
                    [&::-moz-range-progress]:bg-vaux-green
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
                  <span className="text-right text-xs tabular-nums text-vaux-light">
                    {formatTime(seekValue)}
                    {playback.duration > 0 && (
                      <>
                        <span className="text-vaux-green-dark">{" / "}</span>
                        {formatTime(playback.duration)}
                      </>
                    )}
                  </span>
                </>
              )}
            </div>
            {!isHost && playback.isPlaying && (
              <p className="mt-2 text-xs text-zinc-600">
                synced · {formatTime(syncedPosition)}
                {playback.duration > 0 && ` / ${formatTime(playback.duration)}`}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="flex h-24 items-center justify-center px-4 text-center text-sm text-zinc-600 lg:h-48">
          <span className="max-w-xs">
            no track playing —{" "}
            {isHost ? "press ▶ on a queue track" : "waiting for host"}
          </span>
        </div>
      )}
    </div>
  );

  const searchPanel = (
    <div className="flex min-h-0 flex-1 flex-col">
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
          className="flex cursor-pointer items-center justify-center gap-2 rounded bg-zinc-800 px-4 py-2 text-sm transition-colors hover:bg-vaux-green-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching
            </>
          ) : (
            "Search"
          )}
        </button>
      </div>

      {searchResults.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {searchResults.map((r) => (
            <div
              key={r.videoId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-vaux-green p-2 transition-colors hover:border-vaux-green hover:bg-vaux-bg-dark"
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
              <span className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full p-1 text-vaux-green-dark transition-colors hover:text-vaux-green">
                <CirclePlus size={25} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-m text-center uppercase tracking-widest text-zinc-700">
          results will appear here
        </p>
      )}
    </div>
  );

  const queuePanel = (
    <div className="flex min-h-0 flex-1 flex-col">
      {listenersDropdown}
      <div className="flex-1 overflow-y-auto p-3">
        <p className="mb-2 text-xs uppercase tracking-widest text-vaux-green">
          queue
        </p>
        {queue.length === 0 ? (
          <p className="text-xs text-zinc-700">empty — search and add tracks</p>
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
                  <p className="truncate text-xs text-vaux-light">
                    {decodeHTML(track.title)}
                  </p>
                  <p className="truncate text-xs text-vaux-green">
                    {nameForAddedBy(track)}
                  </p>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={() => onVote(track.id, 1)}
                    className="cursor-pointer text-xs text-zinc-500 hover:text-vaux-green"
                  >
                    ▲
                  </button>
                  <span className="text-xs text-zinc-400">{track.votes}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Wrap the button in a span so the tooltip still
                          fires when the button is disabled (HTML disabled
                          buttons swallow pointer events). */}
                      <span className="inline-flex">
                        <button
                          onClick={() => onVote(track.id, -1)}
                          disabled={track.votes < 1}
                          className="cursor-pointer text-xs text-zinc-500 hover:text-[#C44545] disabled:cursor-not-allowed"
                        >
                          ▼
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {track.votes < 1
                        ? "Need at least 1 vote to downvote"
                        : "Downvote — pushes track down the queue"}
                    </TooltipContent>
                  </Tooltip>
                </div>
                {isHost && (
                  <div className="ml-2 flex shrink-0 items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onRemoveFromQueue(track.id)}
                          className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-[#C44545]"
                          aria-label="Remove from queue"
                        >
                          <Trash2 size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        Remove from queue (host only)
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onPlayTrack(track)}
                          className="cursor-pointer text-xs font-bold text-vaux-green-dark transition-transform hover:scale-115 hover:text-[#A2CB8B]"
                          aria-label="Play now"
                        >
                          <Play size={16} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        Play this track now — replaces what&apos;s playing
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const chatPanel = (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="mb-1 px-3 pt-2 text-xs uppercase tracking-widest text-vaux-green">
        chat
      </p>
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
        {messages.map((m, i) => (
          <div key={i} className="text-xs break-words [overflow-wrap:anywhere]">
            {m.system ? (
              <span className="italic text-zinc-600">{m.text}</span>
            ) : (
              <>
                <span
                  className="font-semibold"
                  style={{ color: colorForUser(m.userId) }}
                >
                  {m.username.slice(0, 20)}:{" "}
                </span>
                <span className="text-vaux-light">{m.text}</span>
              </>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div className="relative flex gap-2 p-2">
        <input
          className="flex-1 rounded border border-vaux-green-dark bg-zinc-900 px-2 py-1 text-xs focus:border-vaux-light focus:outline-none"
          placeholder="say something..."
          value={chatInput}
          onChange={(e) => onChatInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSendChat()}
          maxLength={500}
        />
        {chatInput.length > 400 && (
          <span
            className={`pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 text-xs ${
              chatInput.length >= 500 ? "text-[#C44545]" : "text-zinc-600"
            }`}
          >
            {500 - chatInput.length}
          </span>
        )}
        <button
          className="cursor-pointer rounded bg-vaux-green-dark px-3 py-2 text-xs transition-colors hover:bg-vaux-green"
          onClick={onSendChat}
        >
          <SendHorizontal size={20} />
        </button>
      </div>
    </div>
  );

  const tabs: MobileTab<Tab>[] = [
    {
      id: "player",
      label: "Playing",
      description: "Now playing — current track and host controls",
      icon: <Tv2 size={16} />,
    },
    {
      id: "search",
      label: "Search",
      description: "Find tracks on YouTube and add them to the queue",
      icon: <SearchIcon size={16} />,
    },
    {
      id: "queue",
      label: "Queue",
      description: "What's playing next — vote tracks up or down",
      icon: <ListMusic size={16} />,
      badge: queueUnread || undefined,
    },
    {
      id: "chat",
      label: "Chat",
      description: "Talk with everyone in the room",
      icon: <MessageSquare size={16} />,
      badge: chatUnread || undefined,
    },
  ];

  return (
    <main className="flex h-dvh w-full flex-col overflow-hidden bg-black font-mono text-white">
      <div className="flex items-center gap-2 border-b border-vaux-green px-3 py-3 sm:gap-3 sm:px-6">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onLeave}
              className="shrink-0 cursor-pointer text-lg font-bold text-vaux-green transition-colors hover:text-vaux-light"
              aria-label="Leave room"
            >
              vaux
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Leave room — back to lobby
          </TooltipContent>
        </Tooltip>
        <span className="shrink-0 text-zinc-600">/</span>
        {isPrivate ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`flex min-w-0 cursor-pointer items-center gap-1 truncate text-sm transition-colors ${
                  copiedRoom
                    ? "text-vaux-green"
                    : privatePassword
                      ? "text-vaux-green-dark hover:text-vaux-green"
                      : "text-vaux-green-dark"
                } ${!privatePassword ? "cursor-default" : ""}`}
                onClick={handleCopyRoom}
              >
                <Lock className="size-3 shrink-0" aria-hidden />
                private room
                <span className="text-xs text-zinc-700">· chat E2E</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {privatePassword
                ? "Click to copy invite link — share only with people you trust"
                : "Invite link not available after reload (host can re-share original)"}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`min-w-0 cursor-pointer truncate text-sm transition-colors ${
                  copiedRoom
                    ? "text-vaux-green"
                    : "text-vaux-green-dark hover:text-vaux-green"
                }`}
                onClick={handleCopyRoom}
              >
                {roomId}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Click to copy room name — share to invite friends
            </TooltipContent>
          </Tooltip>
        )}
        {!isPrivate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleShareRoom}
                className="shrink-0 cursor-pointer text-vaux-green-dark transition-colors hover:text-vaux-green"
                aria-label="Share room link"
              >
                <Share2 className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Share a join link with the room prefilled
            </TooltipContent>
          </Tooltip>
        )}
        {copiedRoom && (
          <span className="shrink-0 text-xs text-vaux-green">✓ copied</span>
        )}
        <span className="ml-auto min-w-0 truncate text-xs text-vaux-green-dark">
          {isHost ? "host" : "listener"} · {username}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-vaux-green-dark px-2.5 py-1 text-xs text-vaux-green transition-colors hover:border-vaux-green hover:bg-vaux-green-dark/30 hover:text-vaux-light"
              aria-label="How to use vaux"
            >
              <CircleHelp className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">help</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            How vaux works — quick reference
          </TooltipContent>
        </Tooltip>
        {BUG_REPORT_URL && (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={BUG_REPORT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-vaux-green-dark px-2.5 py-1 text-xs text-vaux-green transition-colors hover:border-vaux-green hover:bg-vaux-green-dark/30 hover:text-vaux-light"
                aria-label="Report a bug"
              >
                <Bug className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">report bug</span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Report a bug or request a feature
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onLeave}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-vaux-green-dark px-2.5 py-1 text-xs text-vaux-green transition-colors hover:border-vaux-green hover:bg-vaux-green-dark/30 hover:text-vaux-light"
              aria-label="Leave room"
            >
              <LogOut className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">leave</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Leave the room — your session is saved
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Layout switch: desktop gets a fully drag-resizable shell (player +
          search on the left, queue + chat stacked on the right; each split
          is a real divider so no block can push another off-screen — every
          panel has a minSize and scrolls internally instead). Mobile gets a
          single-panel view with a bottom tab bar so each section has the
          full viewport instead of fighting for a few hundred pixels. */}
      {isDesktop ? (
        <PanelGroup direction="horizontal" autoSaveId="vaux:layout:h" className="min-h-0 flex-1">
          <Panel defaultSize={72} minSize={45} className="flex min-h-0 flex-col">
            <PanelGroup direction="vertical" autoSaveId="vaux:layout:left-v">
              <Panel defaultSize={65} minSize={20} className="min-h-0">
                <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 pb-2">
                  {playerPanel}
                </div>
              </Panel>
              <ResizeHandle direction="vertical" />
              <Panel defaultSize={35} minSize={15} className="min-h-0">
                <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 pt-2">
                  {searchPanel}
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
          <ResizeHandle direction="horizontal" />
          <Panel
            defaultSize={28}
            minSize={18}
            maxSize={45}
            className="flex min-h-0 flex-col border-l border-vaux-green"
          >
            <PanelGroup direction="vertical" autoSaveId="vaux:layout:right-v">
              <Panel defaultSize={60} minSize={20} className="flex min-h-0 flex-col">
                {queuePanel}
              </Panel>
              <ResizeHandle direction="vertical" />
              <Panel defaultSize={40} minSize={15} className="flex min-h-0 flex-col border-t border-vaux-green-dark">
                {chatPanel}
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Panels stay mounted (toggled via `hidden`) so YouTubePlayer
                state, scroll positions, chat input draft, and chatEndRef all
                survive tab switches without remounting. */}
            <div
              className={`flex min-h-0 flex-1 flex-col p-4 ${
                activeTab === "player" ? "" : "hidden"
              }`}
            >
              {playerPanel}
            </div>
            <div
              className={`flex min-h-0 flex-1 flex-col p-4 ${
                activeTab === "search" ? "" : "hidden"
              }`}
            >
              {searchPanel}
            </div>
            <div
              className={`flex min-h-0 flex-1 flex-col ${
                activeTab === "queue" ? "" : "hidden"
              }`}
            >
              {queuePanel}
            </div>
            <div
              className={`flex min-h-0 flex-1 flex-col ${
                activeTab === "chat" ? "" : "hidden"
              }`}
            >
              {chatPanel}
            </div>
          </div>
          <MobileTabBar
            tabs={tabs}
            activeTab={activeTab}
            onChange={setActiveTab}
          />
        </>
      )}

      <HelpModal open={helpOpen} onOpenChange={handleHelpOpenChange} />
      {/* Toaster portals to <body>. top-center avoids the mobile tab bar;
          member-join toasts fire on all breakpoints; queue/chat/host toasts
          are mobile-only. */}
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{
          classNames: {
            toast:
              "!bg-zinc-900 !border-vaux-green-dark !text-vaux-light !font-mono",
            title: "!text-vaux-light",
            description: "!text-zinc-400",
            actionButton:
              "!bg-vaux-green !text-black !font-mono hover:!bg-vaux-light",
          },
        }}
      />
    </main>
  );
}
