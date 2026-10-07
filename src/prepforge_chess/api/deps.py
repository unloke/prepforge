"""Request dependencies: resolve the current user from the session cookie."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from prepforge_chess.api.config import Settings, get_settings
from prepforge_chess.api.db import get_db, get_engine
from prepforge_chess.api.models import AuthSession, User
from prepforge_chess.api.security import hash_session_token
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

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
    if last_seen is None or now - last_seen >= timedelta(days=settings.session_ttl_days):
        db.delete(session)
        db.commit()
        return None
    if last_seen is None or now - last_seen >= _LAST_SEEN_REFRESH:
        session.last_seen_at = now
        db.commit()
    return db.get(User, session.user_id)


def current_user(user: User | None = Depends(current_user_optional)) -> User:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    return user


def get_repository() -> WorkspaceRepository:
    """Domain repository bound to the app's shared SQLAlchemy engine."""
    return WorkspaceRepository(get_engine())


def current_owner(user: User = Depends(current_user)) -> str:
    """Canonical owner id for all SaaS/domain data: ``users.id``.

    No bridge row is materialized — the repository scopes games, repertoires,
    training progress, and settings directly off this id.
    """
    return user.id
