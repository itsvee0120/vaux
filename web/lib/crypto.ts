// Private-room cryptography. Mirrors cli/vaux/crypto.py byte-for-byte —
// any change here must be reflected there. See PRIVATE_ROOMS_SPEC.md for
// the full spec, parameter table, and threat model.

// `-sumo` build includes Argon2id (crypto_pwhash). The minimal
// libsodium-wrappers build omits it.
import sodium from "libsodium-wrappers-sumo";

const PASSWORD_BYTES = 16;
const PASSWORD_REGEX = /^[A-Za-z0-9_-]{22}$/;
const ROOM_ID_BYTES = 16;
const ARGON2_OPSLIMIT = 2;
const ARGON2_MEMLIMIT_BYTES = 67_108_864;
const ARGON2_OUTLEN = 32;
const KDF_SUBKEY_LEN = 32;
const KDF_CTX_RID = "vaux/rid";
const KDF_CTX_ATH = "vaux/ath";
const KDF_CTX_CHT = "vaux/cht";
const KDF_SUBKEY_RID = 1;
const KDF_SUBKEY_ATH = 2;
const KDF_SUBKEY_CHT = 3;

// SHA-256("vaux/private-room/v1")[:16]. Pinned. See PRIVATE_ROOMS_SPEC.md
// for derivation. Bumping requires a v2 protocol marker.
const VAUX_PRIVATE_SALT_HEX = "f4c839505e351f0d2d8733459e2db801";

let saltCache: Uint8Array | null = null;
let readyPromise: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  if (!readyPromise) readyPromise = sodium.ready;
  await readyPromise;
}

function getSalt(): Uint8Array {
  if (!saltCache) saltCache = sodium.from_hex(VAUX_PRIVATE_SALT_HEX);
  return saltCache;
}

export type RoomMaterial = {
  roomId: string;
  authProof: Uint8Array;
  chatKey: Uint8Array;
};

/** New random 22-char base64url password. ~128 bits entropy. */
export async function generatePassword(): Promise<string> {
  await ensureReady();
  const bytes = sodium.randombytes_buf(PASSWORD_BYTES);
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function isWellFormedPassword(password: string): boolean {
  return PASSWORD_REGEX.test(password);
}

/**
 * Derive room material from a password. Argon2id is intentionally slow
 * (~250 ms target) — call once per session and cache the result.
 */
export async function deriveRoomMaterial(
  password: string,
): Promise<RoomMaterial> {
  await ensureReady();

  const passwordBytes = new TextEncoder().encode(password);
  const masterKey = sodium.crypto_pwhash(
    ARGON2_OUTLEN,
    passwordBytes,
    getSalt(),
    ARGON2_OPSLIMIT,
    ARGON2_MEMLIMIT_BYTES,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  const roomIdBytes = sodium.crypto_kdf_derive_from_key(
    KDF_SUBKEY_LEN,
    KDF_SUBKEY_RID,
    KDF_CTX_RID,
    masterKey,
  );
  const roomId = sodium.to_base64(
    roomIdBytes.subarray(0, ROOM_ID_BYTES),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );

  const authProof = sodium.crypto_kdf_derive_from_key(
    KDF_SUBKEY_LEN,
    KDF_SUBKEY_ATH,
    KDF_CTX_ATH,
    masterKey,
  );

  const chatKey = sodium.crypto_kdf_derive_from_key(
    KDF_SUBKEY_LEN,
    KDF_SUBKEY_CHT,
    KDF_CTX_CHT,
    masterKey,
  );

  return { roomId, authProof, chatKey };
}

export function authProofToB64(authProof: Uint8Array): string {
  return sodium.to_base64(authProof, sodium.base64_variants.ORIGINAL);
}

export function bytesToB64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export function b64ToBytes(b64: string): Uint8Array {
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}

export type EncryptedChat = { ct: string; nonce: string };

export async function encryptChat(
  chatKey: Uint8Array,
  text: string,
): Promise<EncryptedChat> {
  await ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = new TextEncoder().encode(text);
  const ct = sodium.crypto_secretbox_easy(plaintext, nonce, chatKey);
  return {
    ct: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

/**
 * Decrypt chat ciphertext. Returns null on auth failure (tampered ct,
 * wrong key, malformed input). Callers must treat null as "drop the
 * message" — never bubble decrypt errors up to the UI.
 */
export async function decryptChat(
  chatKey: Uint8Array,
  ctB64: string,
  nonceB64: string,
): Promise<string | null> {
  await ensureReady();
  try {
    const ct = sodium.from_base64(ctB64, sodium.base64_variants.ORIGINAL);
    const nonce = sodium.from_base64(
      nonceB64,
      sodium.base64_variants.ORIGINAL,
    );
    const plaintext = sodium.crypto_secretbox_open_easy(ct, nonce, chatKey);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
