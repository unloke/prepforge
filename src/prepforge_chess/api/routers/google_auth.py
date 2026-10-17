"""Google OAuth sign-in (primary identity).

Authorization-code + PKCE. ``/login`` redirects to Google; ``/callback``
find-or-creates the ``User`` keyed on the verified Google email, opens a session,
and redirects back to the SPA. The short-lived state + PKCE verifier travel in an
encrypted, HttpOnly cookie (no server-side flow store), mirroring the Lichess link
flow. Both routes 503 when Google credentials are not configured.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.models import User
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.storage.types import Plan
from prepforge_chess.api.routers.auth import _open_session
from prepforge_chess.api.security import decrypt_token, encrypt_token
from prepforge_chess.services.google_oauth import (
    GoogleOAuthError,
    build_authorize_url,
    code_challenge_for,
    exchange_code,
    fetch_userinfo,
    generate_code_verifier,
    generate_state,
)

router = APIRouter(prefix="/api/auth/google", tags=["auth"])

_FLOW_COOKIE = "pf_google_oauth"


def _redirect_uri(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/google/callback"


def _oauth_failure(error: str) -> RedirectResponse:
    response = RedirectResponse(f"/?oauth_error={error}", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(_FLOW_COOKIE, path="/")
    return response


@router.get("/login", name="google_login")
@limiter.limit("20/minute")
def login(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> Response:
    if not settings.google_oauth_enabled:
        return _oauth_failure("google_not_configured")
    verifier = generate_code_verifier()
    state = generate_state()
    url = build_authorize_url(
        client_id=settings.google_client_id,
        redirect_uri=_redirect_uri(request),
        state=state,
        code_challenge=code_challenge_for(verifier),
    )
    response = RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    flow = encrypt_token(json.dumps({"state": state, "verifier": verifier}))
    response.set_cookie(
        key=_FLOW_COOKIE,
        value=flow,
        max_age=600,  # 10 min to approve on accounts.google.com
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/callback", name="google_callback")
@limiter.limit("20/minute")
def callback(
    request: Request,
    code: str = "",
    state: str = "",
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    if not settings.google_oauth_enabled:
        return _oauth_failure("google_not_configured")
    raw = request.cookies.get(_FLOW_COOKIE)
    if not raw:
        return _oauth_failure("google_flow_expired")
    try:
        flow = json.loads(decrypt_token(raw))
    except Exception:  # noqa: BLE001 - any tamper/expiry -> reject
        return _oauth_failure("google_flow_invalid")
    if not code or not state or state != flow.get("state"):
        return _oauth_failure("google_state_mismatch")

    try:
        token = exchange_code(
            code=code,
            code_verifier=flow["verifier"],
            redirect_uri=_redirect_uri(request),
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
        )
        info = fetch_userinfo(token["access_token"])
    except GoogleOAuthError:
        return _oauth_failure("google_provider_error")

    email = str(info["email"]).lower()
    # Find-or-create on the verified email. Google verifies email ownership, so a
    # pre-existing (password) account with the same email is the same person — bind
    # to it rather than erroring on the unique-email constraint.
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            email=email,
            password_hash=None,
            display_name=info.get("name") or None,
            plan=Plan.free,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    # 303 so the browser issues a GET to the SPA shell after the OAuth round-trip.
    response = RedirectResponse("/?signed_in=1", status_code=status.HTTP_303_SEE_OTHER)
    _open_session(db, response, settings, user)
    response.delete_cookie(_FLOW_COOKIE, path="/")
    return response
