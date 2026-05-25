import words from "./room-slug-words.json";

const ADJECTIVES = words.adjectives;
const NOUNS = words.nouns;

/** Memorable 3-part slug: adjective-noun-number (e.g. velvet-orbit-42). */
export function generateRoomSlug(): string {
  const buf = new Uint32Array(3);
  crypto.getRandomValues(buf);

  const adj = ADJECTIVES[buf[0] % ADJECTIVES.length];
  const noun = NOUNS[buf[1] % NOUNS.length];
  const suffix = 10 + (buf[2] % 90);

  return `${adj}-${noun}-${suffix}`;
}
