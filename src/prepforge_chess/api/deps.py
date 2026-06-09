"""Request dependencies: resolve the current user from the session cookie."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db, get_engine
from prepforge_chess.api.models import AuthSession, User
from prepforge_chess.api.security import hash_session_token
from prepforge_chess.storage.repositories import PrepForgeRepository

# Only refresh a session's last_seen_at at most this often. Without it, every
# authenticated request issues a write transaction (a real Postgres bottleneck
# under load); the field only needs minute-granularity for idle-expiry.
_LAST_SEEN_REFRESH = timedelta(minutes=5)


def current_user_optional(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User | None:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None
    session = db.get(AuthSession, hash_session_token(token))
    if session is None:
        return None
    now = datetime.now(timezone.utc)
    last_seen = session.last_seen_at
    # SQLite stores no tz and hands back naive datetimes; subtracting an aware
    # `now` would raise TypeError. (Postgres TIMESTAMPTZ returns aware values, so
    # this only fires on SQLite.) Treat the naive value as UTC for the comparison.
    if last_seen is not None and last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    if last_seen is None or now - last_seen >= _LAST_SEEN_REFRESH:
        session.last_seen_at = now
        db.commit()
    return db.get(User, session.user_id)


def current_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    return user


def require_pro(user: User = Depends(current_user)) -> User:
    """Gate Pro-only features (e.g. creating teams/classrooms)."""
    from prepforge_chess.api.models import Plan

    if user.plan != Plan.pro:
        raise HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail="Pro plan required")
    return user


def get_repository() -> PrepForgeRepository:
    """The legacy domain repository, bound to the app's shared SQLAlchemy engine.

    Both run on one DB/connection pool, so the ported ``/api/*`` data endpoints no
    longer need the old server's single shared connection + global ``request_lock``.
    """
    return PrepForgeRepository(get_engine())


def current_owner(
    user: User = Depends(current_user),
    repo: PrepForgeRepository = Depends(get_repository),
) -> str:
    """Resolve the authenticated user to the ``owner_user_id`` the repository scopes
    owned data by (games, repertoires, training). Per the Phase 2b bridge decision the
    data-owner id IS ``users.id``; we materialize the backing ``user_profiles`` row on
    first touch so legacy owner-scoped queries find an owner to match.
    """
    return repo.ensure_profile(user.id, display_name=user.display_name or user.email)
