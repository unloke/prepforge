"""Lichess OAuth2 (PKCE) for a local, no-secret desktop client.

Lichess lets a public client use Authorization Code + PKCE with no registered
secret, so the whole flow runs against the local web server:

  1. /oauth/login   — make a verifier/challenge, redirect to Lichess.
  2. user approves on lichess.org.
  3. /oauth/callback — exchange the code (+ verifier) for a token, read the
     account username, and store both in app_settings.

Only `urllib` is used so there are no new dependencies, and the network calls
are small wrappers that tests can monkeypatch.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import urllib.error
import urllib.request
from urllib.parse import urlencode


LICHESS_AUTHORIZE_URL = "https://lichess.org/oauth"
LICHESS_TOKEN_URL = "https://lichess.org/api/token"
LICHESS_ACCOUNT_URL = "https://lichess.org/api/account"

# A public client id; PKCE means no secret is needed. Any stable string works.
CLIENT_ID = "prepforge-chess"
DEFAULT_TIMEOUT = 15


class LichessOAuthError(RuntimeError):
    pass


def generate_code_verifier() -> str:
    """A high-entropy PKCE verifier (RFC 7636), base64url without padding."""
    return base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")


def code_challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def generate_state() -> str:
    return secrets.token_urlsafe(24)


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str, scopes=()) -> str:
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "code_challenge_method": "S256",
        "code_challenge": code_challenge,
        "state": state,
    }
    if scopes:
        params["scope"] = " ".join(scopes)
    return LICHESS_AUTHORIZE_URL + "?" + urlencode(params)


def _post_json(url: str, data: dict, *, timeout: float) -> dict:
    encoded = urlencode(data).encode("ascii")
    request = urllib.request.Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise LichessOAuthError("Lichess token endpoint returned HTTP {0}".format(exc.code)) from exc
    except urllib.error.URLError as exc:
        raise LichessOAuthError("Could not reach Lichess: {0}".format(exc.reason)) from exc


def exchange_code(*, code: str, code_verifier: str, redirect_uri: str, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Swap an authorization code for an access token."""
    token = _post_json(
        LICHESS_TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
        },
        timeout=timeout,
    )
    if "access_token" not in token:
        raise LichessOAuthError("Lichess did not return an access token")
    return token


def fetch_account(access_token: str, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    request = urllib.request.Request(
        LICHESS_ACCOUNT_URL,
        headers={"Authorization": "Bearer {0}".format(access_token)},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise LichessOAuthError("Lichess account endpoint returned HTTP {0}".format(exc.code)) from exc
    except urllib.error.URLError as exc:
        raise LichessOAuthError("Could not reach Lichess: {0}".format(exc.reason)) from exc


def fetch_username(access_token: str, *, timeout: float = DEFAULT_TIMEOUT) -> str:
    account = fetch_account(access_token, timeout=timeout)
    username = account.get("username") or account.get("id")
    if not username:
        raise LichessOAuthError("Lichess account response had no username")
    return username
