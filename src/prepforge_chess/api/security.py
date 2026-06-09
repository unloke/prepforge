"""Password hashing, session tokens, and token-at-rest encryption.

Three concerns, deliberately small and dependency-light:

* Passwords -> bcrypt. bcrypt silently truncates at 72 bytes, so we SHA-256 the
  password first (and base64 it to dodge embedded NULs); this also lets arbitrarily
  long passphrases work.
* Sessions -> a high-entropy opaque token handed to the browser; only its SHA-256
  is persisted. A DB leak therefore never yields live session cookies.
* Linked-account OAuth tokens -> Fernet (AES-128-CBC + HMAC) keyed off the app
  secret, so Lichess tokens are encrypted at rest instead of the legacy plaintext.
"""
from __future__ import annotations

import base64
import hashlib
import secrets

import bcrypt
from cryptography.fernet import Fernet

from prepforge_chess.api.config import Settings, get_settings


# --- passwords -------------------------------------------------------------

def _prepare_password(password: str) -> bytes:
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    return base64.b64encode(digest)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prepare_password(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_prepare_password(password), password_hash.encode("ascii"))
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
    # Derive a stable 32-byte Fernet key from the app secret. Fernet wants a
    # urlsafe-base64 32-byte key; SHA-256 of the secret gives exactly 32 bytes.
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.secret_key.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_token(plaintext: str, settings: Settings | None = None) -> str:
    return _fernet(settings or get_settings()).encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_token(ciphertext: str, settings: Settings | None = None) -> str:
    return _fernet(settings or get_settings()).decrypt(ciphertext.encode("ascii")).decode("utf-8")
