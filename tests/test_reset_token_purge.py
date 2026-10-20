"""Unredeemable password-reset links are removed, not kept as dead rows.

A reset link is single-use and short-lived. Once it is spent or expired,
redemption rejects it and minting a new link never touches it, so the row is
unreachable forever. Sessions already had an opportunistic purge on sign-in;
the next sign-in now clears these too, so the table tracks live links only.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api_helpers import csrf_headers


def _register(client, email):
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert response.status_code == 201, response.text


def _reset_rows():
    from prepforge_chess.api.db import get_engine
    from prepforge_chess.api.models import PasswordResetToken

    with Session(get_engine()) as db:
        return db.scalars(select(PasswordResetToken)).all()


def test_spent_and_expired_reset_links_are_purged_on_sign_in(client, monkeypatch):
    from prepforge_chess.api import config
    from prepforge_chess.api.db import get_engine
    from prepforge_chess.api.models import PasswordResetToken

    monkeypatch.setenv("PREPFORGE_PASSWORD_RESET_DEV_LINK", "1")
    config.get_settings.cache_clear()
    _register(client, "purge@example.com")

    minted = client.post(
        "/api/auth/password/forgot",
        json={"email": "purge@example.com"},
        headers=csrf_headers(client),
    ).json()["dev_reset_token"]
    assert len(_reset_rows()) == 1

    # One row spent, one row expired long ago, and one still live.
    user_id = _reset_rows()[0].user_id
    with Session(get_engine()) as db:
        db.execute(update(PasswordResetToken).values(
            used_at=datetime.now(timezone.utc)
        ))
        db.add(PasswordResetToken(
            user_id=user_id, token_hash="expired-hash",
            expires_at=datetime.now(timezone.utc) - timedelta(days=2),
        ))
        db.add(PasswordResetToken(
            user_id=user_id, token_hash="live-hash",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        ))
        db.commit()
    assert len(_reset_rows()) == 3

    # The next successful sign-in purges what nobody can redeem; the live link stays.
    login = client.post(
        "/api/auth/login",
        json={"email": "purge@example.com", "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert login.status_code == 200, login.text
    remaining = _reset_rows()
    assert [row.token_hash for row in remaining] == ["live-hash"]
    assert minted  # the spent link is the one just removed
