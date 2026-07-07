"""Field-level encryption for selected local-only SQLite text columns.

Encryption is opt-in at runtime via ``LSATLAB_DB_KEY_B64``. When unset, existing
developer/test databases keep storing plaintext. When set to a base64-encoded
32-byte key, new writes to columns using ``EncryptedText`` are stored as a
versioned AES-GCM envelope while ORM reads still return plaintext.
"""
from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.types import TEXT, TypeDecorator

from . import config

ENVELOPE_PREFIX = "svenc:"
ENVELOPE_VERSION = 1
ENVELOPE_SCHEME = "lsat-db-field-aesgcm.v1"
KEY_BYTES = 32
IV_BYTES = 12


class FieldEncryptionError(RuntimeError):
    """Raised when an encrypted DB field cannot be decrypted safely."""


def field_encryption_enabled() -> bool:
    return bool(_configured_key_b64())


def _configured_key_b64() -> str:
    return str(getattr(config, "DB_KEY_B64", "") or "").strip()


def validate_db_key_b64(value: str) -> bytes:
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except Exception as exc:  # noqa: BLE001 - normalize key errors for callers
        raise FieldEncryptionError("LSAT DB encryption key is not valid base64") from exc
    if len(raw) != KEY_BYTES:
        raise FieldEncryptionError("LSAT DB encryption key must decode to 32 bytes")
    return raw


def _key() -> bytes | None:
    configured = _configured_key_b64()
    if not configured:
        return None
    return validate_db_key_b64(configured)


def is_encrypted_value(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(ENVELOPE_PREFIX)


def _aad(field_id: str) -> bytes:
    return f"{ENVELOPE_SCHEME}:{field_id}".encode("utf-8")


def encrypt_field(value: str | None, *, field_id: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    if is_encrypted_value(value):
        return value
    key = _key()
    if key is None:
        return value
    iv = os.urandom(IV_BYTES)
    ciphertext = AESGCM(key).encrypt(iv, value.encode("utf-8"), _aad(field_id))
    envelope = {
        "v": ENVELOPE_VERSION,
        "scheme": ENVELOPE_SCHEME,
        "field": field_id,
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ciphertext).decode("ascii"),
    }
    return ENVELOPE_PREFIX + json.dumps(envelope, sort_keys=True, separators=(",", ":"))


def decrypt_field(value: str | None, *, field_id: str) -> str | None:
    if value is None or not is_encrypted_value(value):
        return value
    key = _key()
    if key is None:
        raise FieldEncryptionError("LSAT DB encryption key is required for encrypted fields")
    try:
        envelope = json.loads(value[len(ENVELOPE_PREFIX):])
        if envelope.get("v") != ENVELOPE_VERSION:
            raise FieldEncryptionError("Unsupported LSAT DB encryption envelope version")
        if envelope.get("scheme") != ENVELOPE_SCHEME:
            raise FieldEncryptionError("Unsupported LSAT DB encryption envelope scheme")
        if envelope.get("field") != field_id:
            raise FieldEncryptionError("LSAT DB encryption field binding mismatch")
        iv = base64.b64decode(str(envelope["iv"]).encode("ascii"), validate=True)
        ciphertext = base64.b64decode(str(envelope["ct"]).encode("ascii"), validate=True)
        return AESGCM(key).decrypt(iv, ciphertext, _aad(field_id)).decode("utf-8")
    except FieldEncryptionError:
        raise
    except InvalidTag as exc:
        raise FieldEncryptionError("LSAT DB encrypted field authentication failed") from exc
    except Exception as exc:  # noqa: BLE001 - normalize malformed envelopes
        raise FieldEncryptionError("LSAT DB encrypted field envelope is malformed") from exc


class EncryptedText(TypeDecorator[str]):
    """SQLAlchemy type that encrypts on bind and decrypts on result."""

    impl = TEXT
    cache_ok = True

    def __init__(self, field_id: str, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.field_id = field_id

    def process_bind_param(self, value: str | None, _dialect: Any) -> str | None:
        return encrypt_field(value, field_id=self.field_id)

    def process_result_value(self, value: str | None, _dialect: Any) -> str | None:
        return decrypt_field(value, field_id=self.field_id)
