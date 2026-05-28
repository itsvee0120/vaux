"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { type PlaybackState, getSyncedPosition } from "@/lib/playback";

type YTPlayer = {
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

type YTNamespace = {
  Player: new (
    elementId: string | HTMLElement,
    options: {
      height: string;
      width: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    PLAYING: number;
    PAUSED: number;
    ENDED: number;
    BUFFERING: number;
  };
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_SRC = "https://www.youtube.com/iframe_api";
let apiLoading: Promise<void> | null = null;

// ── loadYouTubeApi ──
// Injects the YouTube IFrame API script once; resolves when YT.Player is ready.
// On script error (network, ad blocker), rejects and clears apiLoading so the
// next mount can retry instead of hanging on a forever-pending promise.
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiLoading) return apiLoading;
  apiLoading = new Promise((resolve, reject) => {
    const done = () => resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      done();
    };
    const existing = document.querySelector(`script[src="${API_SRC}"]`);
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = API_SRC;
      tag.onerror = () => {
        apiLoading = null;
        reject(new Error("YouTube IFrame API failed to load"));
      };
      document.head.appendChild(tag);
    } else if (window.YT?.Player) {
      done();
    }
  });
  return apiLoading;
}

type Props = {
  playback: PlaybackState;
  isHost: boolean;
  /** When true, host play/pause events are not echoed (player hidden / bg tab). */
  suppressHostPlaybackEcho?: boolean;
  onPlay: (positionSeconds: number) => void;
  onPause: (positionSeconds: number) => void;
  onEnded: () => void;
};

// ── YoutubePlayer ──
// Wraps YT.Player for synced listening. Listeners apply remote playback:state;
// the host's play/pause/ended events are emitted back to the server.
export function YoutubePlayer({
  playback,
  isHost,
  suppressHostPlaybackEcho = false,
  onPlay,
  onPause,
  onEnded,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const applyingRemote = useRef(false);
  const applyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastAppliedAt = useRef(0);
  const lastVideoId = useRef<string | null>(null);
  const playbackRef = useRef(playback);
  const tabHiddenRef = useRef(false);
  const suppressEchoRef = useRef(suppressHostPlaybackEcho);

  const [localPlaying, setLocalPlaying] = useState(false);
  const [showBlockedOverlay, setShowBlockedOverlay] = useState(false);

  // Store volatile props in refs so we don't have to recreate the player when they change
  const isHostRef = useRef(isHost);
  const onPlayRef = useRef(onPlay);
  const onPauseRef = useRef(onPause);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  useEffect(() => {
    isHostRef.current = isHost;
    onPlayRef.current = onPlay;
    onPauseRef.current = onPause;
    onEndedRef.current = onEnded;
  }, [isHost, onPlay, onPause, onEnded]);

  useEffect(() => {
    suppressEchoRef.current = suppressHostPlaybackEcho;
  }, [suppressHostPlaybackEcho]);

  // ── applyPlaybackRef ──
  // Stable ref to applyPlayback so buildPlayer can call it without a forward
  // reference — avoids the "accessed before declaration" lint error.
  const applyPlaybackRef = useRef<(state: PlaybackState) => void>(() => {});

  // ── applyPlayback ──
  // Seeks or loads the video to match server state. Sets applyingRemote so host
  // onStateChange handlers do not echo control events back to the server.
  const applyPlayback = useCallback((state: PlaybackState) => {
    const player = playerRef.current;
    if (!player || !readyRef.current || !state.videoId) return;

    const target = getSyncedPosition(state);

    // Prevent the "play -> broadcast -> seek -> buffer -> play" feedback loop
    // by ignoring server echoes if the host is already perfectly in sync.
    if (isHostRef.current) {
      const current = player.getCurrentTime();
      const isPlaying =
        player.getPlayerState() === window.YT?.PlayerState?.PLAYING;
      if (
        state.videoId === lastVideoId.current &&
        state.isPlaying === isPlaying &&
        Math.abs(current - target) < 1.5
      ) {
        lastAppliedAt.current = state.updatedAt;
        return;
      }
    }

    applyingRemote.current = true;

    if (state.videoId !== lastVideoId.current) {
      lastVideoId.current = state.videoId;
      if (state.isPlaying) {
        player.loadVideoById(state.videoId, target);
      } else {
        player.cueVideoById(state.videoId, target);
      }
    } else {
      player.seekTo(target, true);
      if (state.isPlaying) player.playVideo();
      else player.pauseVideo();
    }

    lastAppliedAt.current = state.updatedAt;
    if (applyTimeoutRef.current) clearTimeout(applyTimeoutRef.current);
    applyTimeoutRef.current = setTimeout(() => {
      applyingRemote.current = false;
    }, 2000);
  }, []);

  // Keep the ref in sync so buildPlayer always calls the latest version
  useEffect(() => {
    applyPlaybackRef.current = applyPlayback;
  }, [applyPlayback]);

  // Browsers pause background-tab media; YouTube fires PAUSED which the host
  // would otherwise echo to the server and pause everyone. Re-sync on return.
  useEffect(() => {
    const syncHostPlayerIfPlaying = () => {
      if (!isHostRef.current || !readyRef.current) return;
      const state = playbackRef.current;
      if (!state.isPlaying || !state.videoId) return;
      applyPlaybackRef.current(state);
    };

    const onVisibility = () => {
      tabHiddenRef.current = document.hidden;
      if (!document.hidden) syncHostPlayerIfPlaying();
    };

    tabHiddenRef.current = document.hidden;
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Mobile: player panel uses CSS hidden when another tab is active — same
  // spurious PAUSED as a background browser tab.
  useEffect(() => {
    const wasSuppressed = suppressEchoRef.current;
    suppressEchoRef.current = suppressHostPlaybackEcho;
    if (wasSuppressed && !suppressHostPlaybackEcho) {
      if (!isHostRef.current || !readyRef.current) return;
      const state = playbackRef.current;
      if (state.isPlaying && state.videoId) {
        applyPlaybackRef.current(state);
      }
    }
  }, [suppressHostPlaybackEcho]);

  // ── buildPlayer ──
  // Constructs a fresh YT.Player into wrapperRef. Called on mount and again on
  // unlock so the new instance is created inside a trusted user-gesture stack,
  // which is the only way to defeat YouTube's Error 150 bot-detection on autoplay.
  const buildPlayer = useCallback(
    (autoplayVideoId?: string, startSeconds?: number) => {
      if (!wrapperRef.current || !window.YT) return;

      // Tear down any existing player cleanly before rebuilding
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      readyRef.current = false;
      // Reset lastVideoId so applyPlayback treats the rebuilt player as fresh
      lastVideoId.current = null;

      const targetEl = document.createElement("div");
      wrapperRef.current.innerHTML = "";
      wrapperRef.current.appendChild(targetEl);

      playerRef.current = new window.YT.Player(targetEl, {
        height: "300",
        width: "100%",
        playerVars: {
          autoplay: 0, // Never rely on playerVars autoplay — use loadVideoById instead
          controls: 1, // Always enabled; pointer-events-none handles locking it for listeners
          disablekb: 0,
          modestbranding: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            if (autoplayVideoId) {
              // Called inside a user-gesture stack — loadVideoById here is trusted
              // by YouTube and will not trigger Error 150 or the CDN playback error
              applyingRemote.current = true;
              lastVideoId.current = autoplayVideoId;
              lastAppliedAt.current = playbackRef.current.updatedAt;
              playerRef.current?.loadVideoById(
                autoplayVideoId,
                startSeconds ?? 0,
              );
              applyTimeoutRef.current = setTimeout(() => {
                applyingRemote.current = false;
              }, 2000);
            } else {
              // Normal mount — apply whatever the server says
              applyPlaybackRef.current(playbackRef.current);
            }
          },
          onStateChange: (event) => {
            const YT = window.YT!;
            // Count BUFFERING as "in-flight playing" so the blocked-autoplay
            // overlay doesn't flash during slow connection startup.
            setLocalPlaying(
              event.data === YT.PlayerState.PLAYING ||
                event.data === YT.PlayerState.BUFFERING,
            );

            if (!isHostRef.current) {
              // If listener manually clicks the iframe to bypass restrictions, sync them!
              if (
                event.data === YT.PlayerState.PLAYING &&
                !applyingRemote.current
              ) {
                applyPlaybackRef.current(playbackRef.current);
              }
              return;
            }

            // Host: echo state changes back to the server.
            if (applyingRemote.current || !playerRef.current) return;
            const t = playerRef.current.getCurrentTime();
            const suppressEcho =
              tabHiddenRef.current || suppressEchoRef.current;
            if (event.data === YT.PlayerState.PLAYING) {
              if (!suppressEcho) onPlayRef.current(t);
            } else if (event.data === YT.PlayerState.PAUSED) {
              if (!suppressEcho) onPauseRef.current(t);
            } else if (event.data === YT.PlayerState.ENDED) {
              onEndedRef.current();
            }
          },
        },
      });
    },
    [],
  );

  // ── player init ──
  // Creates YT.Player on mount; rebuilt on unlock via buildPlayer.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await loadYouTubeApi();
      } catch (e) {
        console.error(e);
        return;
      }
      if (cancelled || !window.YT || !wrapperRef.current) return;
      buildPlayer();
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      if (applyTimeoutRef.current) {
        clearTimeout(applyTimeoutRef.current);
        applyTimeoutRef.current = null;
      }
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [buildPlayer]);

  // Detect if listener's browser is blocking autoplay.
  // Derive isBlocked inline so we never call setState synchronously in an effect body.
  useEffect(() => {
    const isBlocked = !isHost && playback.isPlaying && !localPlaying;
    const timer = setTimeout(
      () => setShowBlockedOverlay(isBlocked),
      isBlocked ? 1500 : 0,
    );
    return () => clearTimeout(timer);
  }, [isHost, playback.isPlaying, localPlaying]);

  // ── Unlock helper ──
  // Destroys the poisoned player and rebuilds it synchronously inside the
  // user-gesture stack — the only reliable way to defeat YouTube Error 150.
  const unlock = useCallback(() => {
    const state = playbackRef.current;
    const target = getSyncedPosition(state);

    // Reset all guards before rebuilding
    applyingRemote.current = false;
    if (applyTimeoutRef.current) {
      clearTimeout(applyTimeoutRef.current);
      applyTimeoutRef.current = null;
    }

    // Rebuild the player fresh inside this gesture — YouTube trusts new YT.Player()
    // called synchronously from a click far more than loadVideoById on a stale instance
    buildPlayer(state.videoId ?? undefined, target);
    setShowBlockedOverlay(false);
  }, [buildPlayer]);

  // ── Global click unlock ──
  // If autoplay is blocked, unlock it seamlessly if the user clicks ANYWHERE
  // on the page (e.g., sending a chat message, voting on a song).
  useEffect(() => {
    if (!showBlockedOverlay) return;
    window.addEventListener("pointerdown", unlock, { capture: true });
    return () =>
      window.removeEventListener("pointerdown", unlock, { capture: true });
  }, [showBlockedOverlay, unlock]);

  // ── playback sync ──
  // Re-applies remote state whenever the server broadcasts a new updatedAt.
  useEffect(() => {
    if (!playback.videoId) return;
    if (playback.updatedAt === lastAppliedAt.current) return;
    applyPlayback(playback);
  }, [playback, applyPlayback]);

  // Listeners get pointer-events back only while the overlay is showing
  // (so they can click the button), otherwise keep the iframe locked.
  const lockPointer = !isHost && !showBlockedOverlay;

  return (
    <div className="relative w-full">
      <div
        ref={wrapperRef}
        className={lockPointer ? "pointer-events-none" : undefined}
      />
      {showBlockedOverlay && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <button
            className="cursor-pointer rounded-full bg-vaux-green px-6 py-3 font-bold text-black shadow-lg transition-transform hover:scale-105 active:scale-95"
            onClick={unlock}
          >
            ▶ Click to Unmute / Play
          </button>
          <p className="mt-3 text-xs font-semibold text-vaux-light">
            Browser prevented autoplay
          </p>
        </div>
      )}
    </div>
  );
}
