export type VauxSession = {
  roomId: string;
  username: string;
};

const SESSION_KEY = "vaux-session";

/** Stable snapshot for useSyncExternalStore (same reference until storage changes). */
let cachedRaw: string | null | undefined;
let cachedSnapshot: VauxSession | null = null;

function parseSessionRaw(raw: string | null): VauxSession | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as VauxSession;
    if (data.roomId?.trim() && data.username?.trim()) {
      return { roomId: data.roomId.trim(), username: data.username.trim() };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function refreshSessionCache(): VauxSession | null {
  if (typeof window === "undefined") {
    cachedRaw = null;
    cachedSnapshot = null;
    return null;
  }
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = parseSessionRaw(raw);
  return cachedSnapshot;
}

export function getSessionSnapshot(): VauxSession | null {
  return refreshSessionCache();
}

export function loadSession(): VauxSession | null {
  return getSessionSnapshot();
}

function notifySessionChange() {
  window.dispatchEvent(new Event("vaux-session"));
}

export function subscribeSession(onChange: () => void) {
  window.addEventListener("vaux-session", onChange);
  return () => window.removeEventListener("vaux-session", onChange);
}

export function saveSession(roomId: string, username: string): void {
  const raw = JSON.stringify({
    roomId: roomId.trim(),
    username: username.trim(),
  });
  sessionStorage.setItem(SESSION_KEY, raw);
  cachedRaw = raw;
  cachedSnapshot = parseSessionRaw(raw);
  notifySessionChange();
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  cachedRaw = null;
  cachedSnapshot = null;
  notifySessionChange();
}
