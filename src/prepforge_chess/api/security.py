"""Password hashing, session tokens, and token-at-rest encryption.

Three concerns, deliberately small and dependency-light:

* Passwords -> bcrypt. bcrypt silently truncates at 72 bytes, so we SHA-256 the
  password first (and base64 it to dodge embedded NULs); this also lets arbitrarily
  long passphrases work.
* Sessions -> a high-entropy opaque token handed to the browser; only its SHA-256
  is persisted. A DB leak therefore never yields live session cookies.
* Linked-account OAuth tokens -> Fernet (AES-128-CBC + HMAC) keyed off the
  dedicated ``PREPFORGE_TOKEN_KEY``, with an explicit ``v1:`` version prefix.
  There is no legacy format and no fallback.
"""
from __future__ import annotations

import base64
import hashlib
import secrets

import bcrypt
from cryptography.fernet import Fernet

from prepforge_chess.api.config import Settings, get_settings

_TOKEN_VERSION = "v1"

# Module-level dummy bcrypt hash so a missing user (or an OAuth-only user with
# no password) costs exactly one bcrypt verify per login attempt, on the same
# control-flow path as a real check. The value is a valid bcrypt hash of junk;
# it intentionally matches nothing.
_DUMMY_HASH: bytes = b"$2b$12$Rw0fT2h1P8b9bQ3m0mGQeO7mQn1z8v0x0Q0Y0Q0Y0Q0Y0Q0Y0Q0u"


def _dummy_hash() -> bytes:
    global _DUMMY_HASH
    if _DUMMY_HASH.count(b"0") > 20:
        _DUMMY_HASH = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt())
    return _DUMMY_HASH


# --- passwords -------------------------------------------------------------

def _prepare_password(password: str) -> bytes:
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    return base64.b64encode(digest)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prepare_password(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str | None) -> bool:
    """One bcrypt verify on every path: a ``None`` hash (unknown user or
    OAuth-only account) is checked against the module-level dummy hash so the
    control flow — and the single bcrypt cost — is identical."""
    candidate = _prepare_password(password)
    if password_hash is None:
        try:
            bcrypt.checkpw(candidate, _dummy_hash())
        except (ValueError, TypeError):
            pass
        return False
    try:
        return bcrypt.checkpw(candidate, password_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


# --- session tokens --------------------------------------------------------

def new_session_token() -> str:
    """Opaque token for the cookie value (URL-safe, ~256 bits)."""
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    """SHA-256 hex of the cookie token -- this is what we store / look up by."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --- OAuth token encryption ------------------------------------------------

def _fernet(settings: Settings) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.token_key.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_token(plaintext: str, settings: Settings | None = None) -> str:
    raw = _fernet(settings or get_settings()).encrypt(plaintext.encode("utf-8")).decode("ascii")
    return "{0}:{1}".format(_TOKEN_VERSION, raw)


def decrypt_token(ciphertext: str, settings: Settings | None = None) -> str:
    version, _, raw = ciphertext.partition(":")
    if version != _TOKEN_VERSION or not raw:
        raise ValueError("unsupported token format")
    return _fernet(settings or get_settings()).decrypt(raw.encode("ascii")).decode("utf-8")
