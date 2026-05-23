"use client";

import { useEffect, useRef, useCallback } from "react";
import { type PlaybackState, getSyncedPosition } from "@/lib/playback";

type YTPlayer = {
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
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
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiLoading) return apiLoading;
  apiLoading = new Promise((resolve) => {
    const done = () => resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      done();
    };
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const tag = document.createElement("script");
      tag.src = API_SRC;
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
  onPlay,
  onPause,
  onEnded,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const applyingRemote = useRef(false);
  const lastAppliedAt = useRef(0);
  const lastVideoId = useRef<string | null>(null);
  const playbackRef = useRef(playback);

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

  // ── applyPlayback ──
  // Seeks or loads the video to match server state. Sets applyingRemote so host
  // onStateChange handlers do not echo control events back to the server.
  const applyPlayback = useCallback((state: PlaybackState) => {
    const player = playerRef.current;
    if (!player || !readyRef.current || !state.videoId) return;

    const target = getSyncedPosition(state);
    applyingRemote.current = true;

    if (state.videoId !== lastVideoId.current) {
      lastVideoId.current = state.videoId;
      player.loadVideoById(state.videoId, target);
      if (!state.isPlaying) player.pauseVideo();
    } else {
      player.seekTo(target, true);
      if (state.isPlaying) player.playVideo();
      else player.pauseVideo();
    }

    lastAppliedAt.current = state.updatedAt;
    setTimeout(() => {
      applyingRemote.current = false;
    }, 500);
  }, []);

  // ── player init ──
  // Creates YT.Player on mount; host state changes wire play/pause/ended to parent.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      await loadYouTubeApi();
      if (cancelled || !window.YT || !wrapperRef.current) return;

      const targetEl = document.createElement("div");
      wrapperRef.current.innerHTML = "";
      wrapperRef.current.appendChild(targetEl);

      playerRef.current = new window.YT.Player(targetEl, {
        height: "300",
        width: "100%",
        playerVars: {
          autoplay: 0,
          controls: 1, // Always enabled; pointer-events-none handles locking it for listeners
          disablekb: 0,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            applyPlayback(playbackRef.current);
          },
          onStateChange: (event) => {
            if (
              !isHostRef.current ||
              applyingRemote.current ||
              !playerRef.current
            )
              return;
            const YT = window.YT!;
            const t = playerRef.current.getCurrentTime();
            if (event.data === YT.PlayerState.PLAYING) onPlayRef.current(t);
            else if (event.data === YT.PlayerState.PAUSED)
              onPauseRef.current(t);
            else if (event.data === YT.PlayerState.ENDED) onEndedRef.current();
          },
        },
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [applyPlayback]);

  // ── playback sync ──
  // Re-applies remote state whenever the server broadcasts a new updatedAt.
  useEffect(() => {
    if (!playback.videoId) return;
    if (playback.updatedAt === lastAppliedAt.current) return;
    applyPlayback(playback);
  }, [playback, applyPlayback]);

  return (
    <div
      ref={wrapperRef}
      className={!isHost ? "pointer-events-none" : undefined}
    />
  );
}
