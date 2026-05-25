// Tracks whether the user has seen the in-room help modal. The key is
// versioned so we can re-prompt everyone if the modal contents change
// substantially (e.g. new features they should know about) — just bump v1.
//
// Returns `true` from hasSeenHelp() in SSR and when localStorage is denied
// (private windows, locked-down browsers). That bias prevents the auto-open
// from firing during hydration mismatch or in environments where can't
// record dismissal — better to be silently helpful via the `?` button than
// to repeatedly hijack the room with a popup we can't suppress.
const HELP_KEY = "vaux:help-seen:v1";

export function hasSeenHelp(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(HELP_KEY) !== null;
  } catch {
    return true;
  }
}

export function markHelpSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HELP_KEY, "1");
  } catch {
    // Quota exceeded / storage disabled. Silent failure — auto-open will
    // happen again next visit, which is fine for the rare case.
  }
}
