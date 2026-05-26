"""Private-room cryptography. Mirrors web/lib/crypto.ts byte-for-byte —
any change here must be reflected there. See PRIVATE_ROOMS_SPEC.md for
the full spec, parameter table, and threat model."""

from __future__ import annotations

import base64
import hashlib
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from nacl import bindings as _nb
from nacl.secret import SecretBox
from nacl.utils import random as _nacl_random

PASSWORD_BYTES = 16
PASSWORD_REGEX = re.compile(r"^[A-Za-z0-9_-]{22}$")
ROOM_ID_BYTES = 16

ARGON2_OPSLIMIT = 2
ARGON2_MEMLIMIT_BYTES = 67_108_864
ARGON2_OUTLEN = 32
# libsodium ALG_ARGON2ID13. pynacl exposes no named constant for this value.
ARGON2_ALG = 2

KDF_SUBKEY_LEN = 32
KDF_CTX_RID = b"vaux/rid"
KDF_CTX_ATH = b"vaux/ath"
KDF_CTX_CHT = b"vaux/cht"
KDF_SUBKEY_RID = 1
KDF_SUBKEY_ATH = 2
KDF_SUBKEY_CHT = 3

# SHA-256("vaux/private-room/v1")[:16]. Pinned. Bumping requires v2 marker.
VAUX_PRIVATE_SALT_HEX = "f4c839505e351f0d2d8733459e2db801"
VAUX_PRIVATE_SALT = bytes.fromhex(VAUX_PRIVATE_SALT_HEX)


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def generate_password() -> str:
    """22-char base64url-unpadded password (~128 bits entropy)."""
    raw = os.urandom(PASSWORD_BYTES)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def is_well_formed_password(password: str) -> bool:
    return bool(PASSWORD_REGEX.match(password or ""))


def parse_invite(text: str) -> str | None:
    """Extract a 22-char base64url password from a raw string or invite URL.

    Accepts:
      - bare password: "AAAAAAAAAAAAAAAAAAAAAA"
      - URL with fragment: "http://host/#<password>"
      - URL with fragment + leading '#': "#<password>"
    Returns None if no well-formed password is found.
    """
    if not text:
        return None
    s = text.strip()

    # URL-with-fragment form
    if "://" in s or s.startswith("/") or s.startswith("#"):
        if s.startswith("#"):
            candidate = s[1:]
        else:
            try:
                parsed = urlparse(s)
            except ValueError:
                return None
            candidate = parsed.fragment or ""
        candidate = candidate.split("?")[0].split("&")[0]
        return candidate if is_well_formed_password(candidate) else None

    # Raw password form
    return s if is_well_formed_password(s) else None


# ---------------------------------------------------------------------------
# Key derivation
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RoomMaterial:
    room_id: str
    auth_proof: bytes
    chat_key: bytes


def _kdf(master_key: bytes, subkey_id: int, ctx: bytes) -> bytes:
    """libsodium crypto_kdf_derive_from_key with a hardcoded blake2b fallback
    in case the pynacl build doesn't surface the binding."""
    assert len(master_key) == 32
    assert len(ctx) == 8
    fn = getattr(_nb, "crypto_kdf_derive_from_key", None)
    if fn is not None:
        return fn(KDF_SUBKEY_LEN, subkey_id, ctx, master_key)
    # Fallback matches libsodium's blake2b-based KDF construction:
    # blake2b(personal=ctx, salt=subkey_id_le, key=master_key, msg=b"")
    return hashlib.blake2b(
        b"",
        digest_size=KDF_SUBKEY_LEN,
        key=master_key,
        salt=subkey_id.to_bytes(8, "little"),
        person=ctx,
    ).digest()


def derive_room_material(password: str) -> RoomMaterial:
    """Argon2id (~250 ms) + KDF over a fixed application salt. Cache the
    result for the session — never re-derive per chat message."""
    pw_bytes = password.encode("utf-8")
    # bindings.crypto_pwhash is a submodule; the actual fn we need is
    # crypto_pwhash_alg (raw KDF, alg-selectable). The libsodium constant
    # for ALG_ARGON2ID13 is 2 — pinned in ARGON2_ALG.
    master_key = _nb.crypto_pwhash_alg(
        ARGON2_OUTLEN,
        pw_bytes,
        VAUX_PRIVATE_SALT,
        ARGON2_OPSLIMIT,
        ARGON2_MEMLIMIT_BYTES,
        ARGON2_ALG,
    )

    rid_full = _kdf(master_key, KDF_SUBKEY_RID, KDF_CTX_RID)
    room_id = (
        base64.urlsafe_b64encode(rid_full[:ROOM_ID_BYTES])
        .rstrip(b"=")
        .decode("ascii")
    )
    auth_proof = _kdf(master_key, KDF_SUBKEY_ATH, KDF_CTX_ATH)
    chat_key = _kdf(master_key, KDF_SUBKEY_CHT, KDF_CTX_CHT)

    return RoomMaterial(room_id=room_id, auth_proof=auth_proof, chat_key=chat_key)


# ---------------------------------------------------------------------------
# Encoding helpers — base64 (NOT base64url) on the wire to match web client.
# ---------------------------------------------------------------------------

def auth_proof_to_b64(auth_proof: bytes) -> str:
    return base64.b64encode(auth_proof).decode("ascii")


def bytes_to_b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64_to_bytes(b64: str) -> bytes:
    return base64.b64decode(b64, validate=False)


# ---------------------------------------------------------------------------
# SecretBox (XSalsa20-Poly1305) — chat + username payloads
# ---------------------------------------------------------------------------

def encrypt_chat(chat_key: bytes, text: str) -> dict[str, str]:
    """Returns {"ct": <b64>, "nonce": <b64>}. Wire format identical to JS.
    `EncryptedMessage.bytes` would prepend the nonce to the ciphertext —
    we use `.ciphertext` so the format matches sodium.crypto_secretbox_easy."""
    box = SecretBox(chat_key)
    nonce = _nacl_random(SecretBox.NONCE_SIZE)
    encrypted = box.encrypt(text.encode("utf-8"), nonce)
    return {
        "ct": bytes_to_b64(encrypted.ciphertext),
        "nonce": bytes_to_b64(nonce),
    }


def decrypt_chat(chat_key: bytes, ct_b64: str, nonce_b64: str) -> str | None:
    """Returns plaintext, or None on tamper / wrong key / malformed input.
    Callers must drop None silently — never bubble decrypt errors to the UI."""
    try:
        box = SecretBox(chat_key)
        ct = b64_to_bytes(ct_b64)
        nonce = b64_to_bytes(nonce_b64)
        return box.decrypt(ct, nonce).decode("utf-8")
    except Exception:
        return None
