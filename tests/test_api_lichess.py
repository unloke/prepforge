"""Lichess account-linking flow (OAuth network calls mocked)."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from api_helpers import csrf_headers


@pytest.fixture(autouse=True)
def _mock_lichess(monkeypatch):
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.exchange_code",
        lambda **kw: {"access_token": "lichess-tok", "token_type": "Bearer"},
    )
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username",
        lambda token, **kw: "TestUser",
    )


def _register(client, email):
    client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )


def _run_link_flow(client):
    # Start: returns a redirect to lichess + sets the encrypted flow cookie.
    r = client.get("/api/lichess/login", follow_redirects=False)
    assert r.status_code == 307
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    # Callback: exchange (mocked) + persist the link.
    return client.get(
        f"/api/lichess/callback?code=abc&state={state}", follow_redirects=False
    )


def test_link_status_and_unlink(client):
    _register(client, "coach@example.com")

    assert client.get("/api/lichess").json() == {"linked": False, "username": None}

    r = _run_link_flow(client)
    assert r.status_code == 303
    assert "lichess=linked" in r.headers["location"]

    status = client.get("/api/lichess").json()
    assert status == {"linked": True, "username": "TestUser"}

    # Token is stored encrypted, never plaintext.
    from prepforge_chess.api import db
    from prepforge_chess.api.models import LinkedAccount

    with db.make_engine().connect() as conn:
        row = conn.exec_driver_sql("SELECT encrypted_token FROM linked_accounts").fetchone()
    assert row is not None
    assert "lichess-tok" not in row[0]  # ciphertext, not the raw token

    # Unlink.
    assert client.delete("/api/lichess", headers=csrf_headers(client)).status_code == 204
    assert client.get("/api/lichess").json()["linked"] is False
    _ = LinkedAccount  # imported for clarity of what table we asserted on


def test_callback_rejects_state_mismatch(client):
    _register(client, "coach@example.com")
    client.get("/api/lichess/login", follow_redirects=False)
    r = client.get("/api/lichess/callback?code=abc&state=wrong", follow_redirects=False)
    assert r.status_code == 400


def test_cannot_link_account_owned_by_another_user(client):
    # User A links TestUser.
    _register(client, "a@example.com")
    assert _run_link_flow(client).status_code == 303
    client.post("/api/auth/logout", headers=csrf_headers(client))

    # User B tries to link the same Lichess identity -> 409.
    _register(client, "b@example.com")
    r = _run_link_flow(client)
    assert r.status_code == 409


def test_link_requires_auth(client):
    assert client.get("/api/lichess/login", follow_redirects=False).status_code == 401
