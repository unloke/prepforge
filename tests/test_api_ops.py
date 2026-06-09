"""Phase 6 ops: session cap + expired-session purge, and the legal pages.

The session-management items were deferred from Phase 1b; these prove the cap prunes
the oldest sessions and that long-idle sessions are purged opportunistically on the
next login.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str = "a@example.com") -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _login(client: TestClient, email: str = "a@example.com") -> None:
    r = client.post(
        "/api/auth/login",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200, r.text


def _session_count(user_id: str) -> int:
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session

    from prepforge_chess.api import db
    from prepforge_chess.api.models import AuthSession

    with Session(db.get_engine()) as s:
        return int(
            s.execute(
                select(func.count()).select_from(AuthSession).where(
                    AuthSession.user_id == user_id
                )
            ).scalar_one()
        )


def _set_session_max(monkeypatch, n: int) -> None:
    monkeypatch.setenv("PREPFORGE_SESSION_MAX_PER_USER", str(n))
    from prepforge_chess.api import config

    config.get_settings.cache_clear()


# ---- session cap -----------------------------------------------------------


def test_session_cap_prunes_oldest(client, monkeypatch):
    _set_session_max(monkeypatch, 3)
    user_id = _register(client)  # session #1
    for _ in range(5):
        _login(client)  # each opens a new session
    assert _session_count(user_id) == 3


def test_session_cap_zero_disables(client, monkeypatch):
    _set_session_max(monkeypatch, 0)
    user_id = _register(client)
    for _ in range(4):
        _login(client)
    assert _session_count(user_id) == 5  # 1 register + 4 logins, none pruned


# ---- expired-session purge -------------------------------------------------


def test_idle_sessions_purged_on_next_login(client, monkeypatch):
    user_id = _register(client)
    # Back-date the registration session well past the 30-day TTL.
    from sqlalchemy import select, update
    from sqlalchemy.orm import Session

    from prepforge_chess.api import db
    from prepforge_chess.api.models import AuthSession

    old = datetime.now(timezone.utc) - timedelta(days=99)
    with Session(db.get_engine()) as s:
        s.execute(update(AuthSession).where(AuthSession.user_id == user_id).values(
            last_seen_at=old, created_at=old
        ))
        s.commit()
        before = s.scalars(select(AuthSession.token_hash)).all()
    assert len(before) == 1

    _login(client)  # _open_session runs _purge_expired

    # The stale session is gone; only the fresh login session remains.
    with Session(db.get_engine()) as s:
        after = s.scalars(select(AuthSession.token_hash)).all()
    assert len(after) == 1
    assert after[0] not in before


# ---- legal pages -----------------------------------------------------------


def test_terms_page_served(client):
    r = client.get("/terms")
    assert r.status_code == 200
    assert "Terms of Service" in r.text


def test_privacy_page_served(client):
    r = client.get("/privacy")
    assert r.status_code == 200
    assert "Privacy Policy" in r.text
