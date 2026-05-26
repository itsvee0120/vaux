// sessionStorage-backed session for both public and private rooms.
// Private rooms persist authProof + chatKey (base64) so a tab reload can
// rejoin without re-prompting; the password itself is discarded after
// derivation per PRIVATE_ROOMS_SPEC.md ("Session material").

export type PrivateSessionMaterial = {
  authProofB64: string;
  chatKeyB64: string;
};

export type VauxSession = {
  roomId: string;
  username: string;
  /** Present iff this session belongs to a private room. */
  privateMaterial?: PrivateSessionMaterial;
};

const SESSION_KEY = "vaux-session";

let cachedRaw: string | null | undefined;
let cachedSnapshot: VauxSession | null = null;

function parsePrivateMaterial(value: unknown): PrivateSessionMaterial | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.authProofB64 !== "string" || typeof v.chatKeyB64 !== "string") {
    return null;
  }
  if (!v.authProofB64 || !v.chatKeyB64) return null;
  return { authProofB64: v.authProofB64, chatKeyB64: v.chatKeyB64 };
}

function parseSessionRaw(raw: string | null): VauxSession | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<VauxSession>;
    const roomId = data.roomId?.trim();
    const username = data.username?.trim();
    if (!roomId || !username) return null;
    const privateMaterial = parsePrivateMaterial(data.privateMaterial);
    return privateMaterial
      ? { roomId, username, privateMaterial }
      : { roomId, username };
  } catch {
    return null;
  }
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

export function saveSession(
  roomId: string,
  username: string,
  privateMaterial?: PrivateSessionMaterial,
): void {
  const session: VauxSession = privateMaterial
    ? { roomId: roomId.trim(), username: username.trim(), privateMaterial }
    : { roomId: roomId.trim(), username: username.trim() };
  const raw = JSON.stringify(session);
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
