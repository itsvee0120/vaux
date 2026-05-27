// KDF pin test for private rooms. The fixture under fixtures/ is the
// authoritative cross-client contract — cli/tests/test_crypto.py reads
// the same JSON and asserts byte-equality. Regenerate with:
//   npm run test:update
// Any regeneration must be deliberate; bumping crypto constants invalidates
// every existing private-room invite link.

import { describe, it, expect, beforeAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sodium from "libsodium-wrappers-sumo";
import {
  authProofToB64,
  decryptChat,
  deriveRoomMaterial,
  encryptChat,
  generatePassword,
  isWellFormedPassword,
} from "../lib/crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");
const FIXTURE_PATH = join(FIXTURE_DIR, "kdf-vector.json");
const FIXTURE_PASSWORD = "AAAAAAAAAAAAAAAAAAAAAA";
const FIXTURE_PLAINTEXT = "hello vaux";

beforeAll(async () => {
  await sodium.ready;
});

describe("KDF pin", () => {
  it("matches kdf-vector.json (regen with `npm run test:update`)", async () => {
    const material = await deriveRoomMaterial(FIXTURE_PASSWORD);

    const encrypted = await encryptChat(material.chatKey, FIXTURE_PLAINTEXT);

    const computed = {
      password: FIXTURE_PASSWORD,
      salt_hex: "f4c839505e351f0d2d8733459e2db801",
      auth_proof_hex: sodium.to_hex(material.authProof),
      auth_proof_b64: authProofToB64(material.authProof),
      chat_key_hex: sodium.to_hex(material.chatKey),
      room_id_b64url: material.roomId,
      chat_round_trip: {
        plaintext: FIXTURE_PLAINTEXT,
        // ct/nonce are random per encrypt; decrypt-back is the actual contract.
        decrypts_back: await decryptChat(
          material.chatKey,
          encrypted.ct,
          encrypted.nonce,
        ),
      },
    };

    if (process.env.UPDATE_FIXTURE === "1") {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(FIXTURE_PATH, JSON.stringify(computed, null, 2) + "\n");
      return;
    }

    if (!existsSync(FIXTURE_PATH)) {
      throw new Error(
        `kdf-vector.json missing. Bootstrap with: UPDATE_FIXTURE=1 npm test`,
      );
    }

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(computed).toEqual(fixture);
  });
});

describe("chat round trip", () => {
  it("encrypts and decrypts back to the original plaintext", async () => {
    const material = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const { ct, nonce } = await encryptChat(material.chatKey, "hello vaux");
    const back = await decryptChat(material.chatKey, ct, nonce);
    expect(back).toBe("hello vaux");
  });

  it("returns null on tampered ciphertext", async () => {
    const material = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const { ct, nonce } = await encryptChat(material.chatKey, "hello vaux");
    const flipChar = ct[0] === "A" ? "B" : "A";
    const tampered = flipChar + ct.slice(1);
    const back = await decryptChat(material.chatKey, tampered, nonce);
    expect(back).toBeNull();
  });

  it("returns null on wrong key", async () => {
    const a = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const b = await deriveRoomMaterial("BBBBBBBBBBBBBBBBBBBBBB");
    const { ct, nonce } = await encryptChat(a.chatKey, "secret");
    expect(await decryptChat(b.chatKey, ct, nonce)).toBeNull();
  });

  it("returns null on garbage base64", async () => {
    const material = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const back = await decryptChat(material.chatKey, "not-base64!!!", "nope");
    expect(back).toBeNull();
  });
});

describe("password format", () => {
  it("generates a 22-char base64url password", async () => {
    const p = await generatePassword();
    expect(p).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isWellFormedPassword(p)).toBe(true);
  });

  it("rejects malformed passwords", () => {
    expect(isWellFormedPassword("")).toBe(false);
    expect(isWellFormedPassword("too-short")).toBe(false);
    expect(isWellFormedPassword("X".repeat(23))).toBe(false);
    expect(isWellFormedPassword("contains spaces here aa")).toBe(false);
    expect(isWellFormedPassword("base64+with/bad=chars=22")).toBe(false);
  });

  it("derives the same material twice for the same password", async () => {
    const a = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const b = await deriveRoomMaterial(FIXTURE_PASSWORD);
    expect(a.roomId).toBe(b.roomId);
    expect(sodium.to_hex(a.authProof)).toBe(sodium.to_hex(b.authProof));
    expect(sodium.to_hex(a.chatKey)).toBe(sodium.to_hex(b.chatKey));
  });

  it("derives different material for different passwords", async () => {
    const a = await deriveRoomMaterial(FIXTURE_PASSWORD);
    const b = await deriveRoomMaterial("ZZZZZZZZZZZZZZZZZZZZZZ");
    expect(a.roomId).not.toBe(b.roomId);
  });
});
