// Per-viewer video-frame shape preference. Persisted to localStorage only —
// this never touches PlaybackState/sockets (see server/index.js), because it
// describes how *this browser* displays the player, not what's playing.

import { useSyncExternalStore } from "react";

export type AspectRatioId = "16:9" | "21:9" | "9:16" | "1:1";

export type AspectRatioPreset = {
  id: AspectRatioId;
  label: string;
  /** CSS `aspect-ratio` value. */
  css: string;
};

// Layout allocation (how much room the player/search/queue/chat blocks each
// get) is owned by the drag-resizable panels in LobbyPage.tsx — this only
// picks the video's own shape. The player fits itself inside whatever space
// its panel is given (see YoutubePlayer.tsx), so it can never overflow.
export const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { id: "16:9", label: "16:9", css: "16 / 9" },
  { id: "21:9", label: "21:9", css: "21 / 9" },
  { id: "9:16", label: "9:16", css: "9 / 16" },
  { id: "1:1", label: "1:1", css: "1 / 1" },
];

export const DEFAULT_ASPECT_RATIO: AspectRatioId = "16:9";

const PRESET_BY_ID: Record<AspectRatioId, AspectRatioPreset> = Object.fromEntries(
  ASPECT_RATIO_PRESETS.map((p) => [p.id, p]),
) as Record<AspectRatioId, AspectRatioPreset>;

export function getAspectRatioPreset(id: AspectRatioId): AspectRatioPreset {
  return PRESET_BY_ID[id];
}

const RATIO_KEY = "vaux:player-ratio:v1";

function isAspectRatioId(value: string | null): value is AspectRatioId {
  return value != null && value in PRESET_BY_ID;
}

export function getPlayerAspectRatio(): AspectRatioId {
  if (typeof window === "undefined") return DEFAULT_ASPECT_RATIO;
  try {
    const stored = window.localStorage.getItem(RATIO_KEY);
    return isAspectRatioId(stored) ? stored : DEFAULT_ASPECT_RATIO;
  } catch {
    return DEFAULT_ASPECT_RATIO;
  }
}

export function setPlayerAspectRatio(id: AspectRatioId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RATIO_KEY, id);
  } catch {
    /* quota exceeded / storage disabled — ignore, matches help-storage.ts */
  }
}

function subscribeNoop() {
  return () => {};
}

// Hydration-safe read of the stored preference — mirrors useHydrated/
// useStoredSession in app/page.tsx. getServerSnapshot returns the default so
// SSR and the pre-hydration client render match; the real snapshot is picked
// up on the client without tripping react-hooks/set-state-in-effect.
export function useStoredPlayerAspectRatio(): AspectRatioId {
  return useSyncExternalStore(
    subscribeNoop,
    getPlayerAspectRatio,
    () => DEFAULT_ASPECT_RATIO,
  );
}

// Whether the frame-shape preset row is tucked away. Defaults to expanded
// (false) so first-time viewers discover it; once someone collapses it to
// save space, that choice is remembered.
const COLLAPSE_KEY = "vaux:ratio-menu-collapsed:v1";

export function getRatioMenuCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setRatioMenuCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    /* quota exceeded / storage disabled — ignore */
  }
}

export function useStoredRatioMenuCollapsed(): boolean {
  return useSyncExternalStore(subscribeNoop, getRatioMenuCollapsed, () => false);
}
