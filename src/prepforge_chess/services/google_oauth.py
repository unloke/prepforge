"""Google OAuth2 / OpenID Connect helpers.

Standard authorization-code flow with PKCE, targeting Google's OIDC endpoints.
Mirrors ``services.lichess_oauth`` (same urllib-only approach, no extra deps) but
Google is the PRIMARY sign-in: the callback find-or-creates a ``User`` keyed on the
verified Google email, rather than linking a secondary identity.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import urllib.error
import urllib.request
from urllib.parse import urlencode

GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

DEFAULT_TIMEOUT = 10.0
SCOPES = ("openid", "email", "profile")


class GoogleOAuthError(RuntimeError):
    """Any failure talking to Google's OAuth/OIDC endpoints."""


def generate_state() -> str:
    return secrets.token_urlsafe(24)


def generate_code_verifier() -> str:
    return secrets.token_urlsafe(48)


def code_challenge_for(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_authorize_url(
    *,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "access_type": "online",
        # Always show the account chooser so a shared browser can switch accounts.
        "prompt": "select_account",
    }
    return GOOGLE_AUTHORIZE_URL + "?" + urlencode(params)


def _post_form(url: str, data: dict, *, timeout: float) -> dict:
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
        body = exc.read().decode("utf-8", "replace")
        raise GoogleOAuthError("google token endpoint error {0}: {1}".format(exc.code, body)) from exc
    except urllib.error.URLError as exc:
        raise GoogleOAuthError("google token endpoint unreachable: {0}".format(exc)) from exc


def exchange_code(
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    client_id: str,
    client_secret: str,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict:
    token = _post_form(
        GOOGLE_TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=timeout,
    )
    if "access_token" not in token:
        raise GoogleOAuthError("google token response missing access_token")
    return token


def fetch_userinfo(access_token: str, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Return the OIDC userinfo claims (email, email_verified, name, sub, ...)."""
    request = urllib.request.Request(
        GOOGLE_USERINFO_URL,
        headers={"Authorization": "Bearer {0}".format(access_token)},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            info = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise GoogleOAuthError("google userinfo error {0}: {1}".format(exc.code, body)) from exc
    except urllib.error.URLError as exc:
        raise GoogleOAuthError("google userinfo unreachable: {0}".format(exc)) from exc
    if not info.get("email"):
        raise GoogleOAuthError("google userinfo missing email")
    return info
