export type PlaybackState = {
  videoId: string | null;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  trackId: string | null;
  positionSeconds: number;
  isPlaying: boolean;
  updatedAt: number;
};

// ── getSyncedPosition ──
// README sync formula: extrapolate playback position from last server snapshot.
// Paused rooms return positionSeconds as-is (no drift while stopped).
export function getSyncedPosition(state: PlaybackState): number {
  if (!state.isPlaying) return state.positionSeconds;
  return (
    state.positionSeconds + (Date.now() - state.updatedAt) / 1000
  );
}

export const EMPTY_PLAYBACK: PlaybackState = {
  videoId: null,
  title: null,
  channel: null,
  thumbnail: null,
  trackId: null,
  positionSeconds: 0,
  isPlaying: false,
  updatedAt: Date.now(),
};
