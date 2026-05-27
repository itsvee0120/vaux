"""Cross-client KDF pin test. Reads the same JSON fixture committed by the
web vitest run (`web/__tests__/fixtures/kdf-vector.json`) and asserts byte
equality — if either client drifts on Argon2 params, KDF context strings,
or encoding, this fails before users hit "wrong password" in production."""

from __future__ import annotations

import json
from pathlib import Path

from vaux.crypto import (
    auth_proof_to_b64,
    bytes_to_b64,
    decrypt_chat,
    derive_room_material,
    encrypt_chat,
    generate_password,
    is_well_formed_password,
    parse_invite,
    VAUX_PRIVATE_SALT_HEX,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "web" / "__tests__" / "fixtures" / "kdf-vector.json"


def _load_fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_kdf_vector_matches_web_fixture():
    vec = _load_fixture()
    # Sanity: both clients must agree on the salt before we check derivations.
    assert vec["salt_hex"] == VAUX_PRIVATE_SALT_HEX

    material = derive_room_material(vec["password"])

    assert material.auth_proof.hex() == vec["auth_proof_hex"], (
        "auth_proof drift — JS and Python derived different bytes"
    )
    assert auth_proof_to_b64(material.auth_proof) == vec["auth_proof_b64"]
    assert material.chat_key.hex() == vec["chat_key_hex"]
    assert material.room_id == vec["room_id_b64url"]


def test_chat_round_trip_local():
    material = derive_room_material("AAAAAAAAAAAAAAAAAAAAAA")
    enc = encrypt_chat(material.chat_key, "hello vaux")
    assert set(enc.keys()) == {"ct", "nonce"}
    assert decrypt_chat(material.chat_key, enc["ct"], enc["nonce"]) == "hello vaux"


def test_chat_decrypts_web_fixture_round_trip_text():
    """Pinned plaintext from the web fixture must round-trip locally with
    the same chat_key, even though the ciphertext bytes themselves differ
    (random nonce per encryption — that's expected)."""
    vec = _load_fixture()
    material = derive_room_material(vec["password"])
    expected_plaintext = vec["chat_round_trip"]["plaintext"]
    enc = encrypt_chat(material.chat_key, expected_plaintext)
    got = decrypt_chat(material.chat_key, enc["ct"], enc["nonce"])
    assert got == expected_plaintext == vec["chat_round_trip"]["decrypts_back"]


def test_decrypt_returns_none_on_tamper():
    material = derive_room_material("AAAAAAAAAAAAAAAAAAAAAA")
    enc = encrypt_chat(material.chat_key, "secret")
    # Flip one byte in the ciphertext payload.
    bad_ct = bytes_to_b64(b"\x00" + enc["ct"][:-1].encode())
    assert decrypt_chat(material.chat_key, bad_ct, enc["nonce"]) is None


def test_decrypt_returns_none_on_wrong_key():
    a = derive_room_material("AAAAAAAAAAAAAAAAAAAAAA")
    b = derive_room_material("BBBBBBBBBBBBBBBBBBBBBB")
    enc = encrypt_chat(a.chat_key, "secret")
    assert decrypt_chat(b.chat_key, enc["ct"], enc["nonce"]) is None


def test_decrypt_returns_none_on_garbage():
    material = derive_room_material("AAAAAAAAAAAAAAAAAAAAAA")
    assert decrypt_chat(material.chat_key, "not-base64!!!", "nope") is None


def test_password_format():
    pw = generate_password()
    assert is_well_formed_password(pw)
    assert len(pw) == 22
    assert not is_well_formed_password("short")
    assert not is_well_formed_password("A" * 21)
    assert not is_well_formed_password("A" * 22 + "X")
    assert not is_well_formed_password("A" * 21 + "+")  # '+' not in url-safe alphabet


def test_distinct_passwords_yield_distinct_material():
    a = derive_room_material(generate_password())
    b = derive_room_material(generate_password())
    assert a.room_id != b.room_id
    assert a.auth_proof != b.auth_proof
    assert a.chat_key != b.chat_key


def test_parse_invite_url_with_fragment():
    assert (
        parse_invite("http://localhost:3000/#AAAAAAAAAAAAAAAAAAAAAA")
        == "AAAAAAAAAAAAAAAAAAAAAA"
    )


def test_parse_invite_bare_password():
    assert (
        parse_invite("  AAAAAAAAAAAAAAAAAAAAAA  ")
        == "AAAAAAAAAAAAAAAAAAAAAA"
    )


def test_parse_invite_fragment_only():
    assert (
        parse_invite("#AAAAAAAAAAAAAAAAAAAAAA")
        == "AAAAAAAAAAAAAAAAAAAAAA"
    )


def test_parse_invite_rejects_garbage():
    assert parse_invite("") is None
    assert parse_invite("https://example.com") is None
    assert parse_invite("velvet-orbit-42") is None
    assert parse_invite("http://x/#tooshort") is None
