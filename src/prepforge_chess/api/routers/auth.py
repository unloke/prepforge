"""Email/password authentication.

Register / login mint a server-side session and set an HttpOnly cookie. The
cookie carries an opaque token; the DB stores only its hash. In production the
cookie is Secure + SameSite=Lax (set in main.set_session_cookie).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db
from prepforge_chess.api.deps import current_user, current_user_optional
from prepforge_chess.api.models import AuthSession, Plan, User
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.api.security import (
    hash_password,
    hash_session_token,
    new_session_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str | None = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: str
    email: str
    plan: Plan
    display_name: str | None

    model_config = {"from_attributes": True}


def _set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )


def _purge_expired(db: Session, settings: Settings) -> int:
    """Delete sessions idle longer than ``session_ttl_days``. Does NOT commit — the
    caller owns the transaction (called inside ``_open_session``)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.session_ttl_days)
    rows = db.scalars(select(AuthSession).where(AuthSession.last_seen_at < cutoff)).all()
    for row in rows:
        db.delete(row)
    return len(rows)


def _enforce_session_cap(db: Session, settings: Settings, user_id: str) -> None:
    """Keep at most ``session_max_per_user`` live sessions per user — prune the oldest
    so a stolen-then-rotated cookie or an unbounded device list can't accumulate
    forever. ``0`` disables the cap."""
    cap = settings.session_max_per_user
    if cap <= 0:
        return
    sessions = db.scalars(
        select(AuthSession)
        .where(AuthSession.user_id == user_id)
        .order_by(AuthSession.created_at.desc())
    ).all()
    for stale in sessions[cap:]:
        db.delete(stale)


def _open_session(db: Session, response: Response, settings: Settings, user: User) -> None:
    token = new_session_token()
    db.add(AuthSession(token_hash=hash_session_token(token), user_id=user.id))
    db.flush()
    _enforce_session_cap(db, settings, user.id)
    # Opportunistic global cleanup of long-idle sessions (no scheduler needed).
    _purge_expired(db, settings)
    db.commit()
    _set_session_cookie(response, settings, token)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/hour")
def register(
    request: Request,
    body: RegisterRequest,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        plan=Plan.free,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    _open_session(db, response, settings, user)
    return user


@router.post("/login", response_model=UserOut)
@limiter.limit("10/minute")
def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    # Verify even on miss against a dummy hash would be ideal; keep simple but
    # avoid leaking which half failed via the message.
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password"
        )
    _open_session(db, response, settings, user)
    return user


def _close_session(request: Request, db: Session, settings: Settings) -> None:
    """Delete the current session row (if any). The caller clears the cookie."""
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        session = db.get(AuthSession, hash_session_token(token))
        if session is not None:
            db.delete(session)
            db.commit()


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    _close_session(request, db, settings)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/signout")
def signout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    """Legacy SPA shim: web-src/app.js POSTs ``/api/auth/signout`` and expects
    ``{ok: true}``. Same effect as ``/logout`` (drop the session + clear the cookie);
    the old server's "rotate to a fresh guest" has no analogue here (the SaaS model has
    no guest sessions — you are either authenticated or anonymous)."""
    _close_session(request, db, settings)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"ok": True}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> User:
    return user


class AuthStatus(BaseModel):
    signed_in: bool
    username: str | None = None


@router.get("/status", response_model=AuthStatus)
def status_(user: User | None = Depends(current_user_optional)) -> AuthStatus:
    """Compatibility shim for the legacy SPA's Sign-out affordance. Unlike the old
    server (where "signed in" meant "has a Lichess username"), an authenticated
    email/password ``User`` IS the account here, so ``signed_in`` keys off the
    session and ``username`` shows the account's display name."""
    if user is None:
        return AuthStatus(signed_in=False)
    return AuthStatus(signed_in=True, username=user.display_name or user.email)


