export type VauxSession = {
  roomId: string;
  username: string;
};

const SESSION_KEY = "vaux-session";

export function loadSession(): VauxSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as VauxSession;
    if (data.roomId?.trim() && data.username?.trim()) {
      return { roomId: data.roomId.trim(), username: data.username.trim() };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

export function saveSession(roomId: string, username: string): void {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ roomId: roomId.trim(), username: username.trim() }),
  );
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}
