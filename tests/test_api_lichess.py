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

    assert client.get("/api/lichess").json() == {"linked": False, "username": None, "accounts": []}

    r = _run_link_flow(client)
    assert r.status_code == 303
    assert "lichess=linked" in r.headers["location"]

    status = client.get("/api/lichess").json()
    assert status["linked"] is True
    assert status["username"] == "TestUser"
    assert len(status["accounts"]) == 1
    assert status["accounts"][0]["username"] == "TestUser"
    assert status["accounts"][0]["is_primary"] is True

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


def test_second_identity_links_alongside_first_and_can_become_primary(client, monkeypatch):
    _register(client, "multi@example.com")
    assert _run_link_flow(client).status_code == 303

    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username",
        lambda token, **kw: "SecondUser",
    )
    assert _run_link_flow(client).status_code == 303

    status = client.get("/api/lichess").json()
    assert status["linked"] is True
    assert status["username"] == "TestUser"
    assert {a["username"] for a in status["accounts"]} == {"TestUser", "SecondUser"}
    primaries = [a for a in status["accounts"] if a["is_primary"]]
    assert len(primaries) == 1 and primaries[0]["username"] == "TestUser"

    second = next(a for a in status["accounts"] if a["username"] == "SecondUser")
    r = client.post(
        "/api/lichess/primary",
        json={"account_id": second["id"]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 200
    status = r.json()
    assert status["username"] == "SecondUser"
    assert [a["username"] for a in status["accounts"] if a["is_primary"]] == ["SecondUser"]


def test_same_user_relinking_same_identity_refreshes_token_and_primary(client):
    _register(client, "relink@example.com")
    assert _run_link_flow(client).status_code == 303
    first = client.get("/api/lichess").json()
    assert len(first["accounts"]) == 1

    assert _run_link_flow(client).status_code == 303
    second = client.get("/api/lichess").json()
    assert len(second["accounts"]) == 1
    assert second["accounts"][0]["is_primary"] is True


def test_unlink_one_promotes_oldest_remaining_to_primary(client, monkeypatch):
    _register(client, "unlinkone@example.com")
    assert _run_link_flow(client).status_code == 303

    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username",
        lambda token, **kw: "SecondUser",
    )
    assert _run_link_flow(client).status_code == 303

    status = client.get("/api/lichess").json()
    primary = next(a for a in status["accounts"] if a["is_primary"])
    other = next(a for a in status["accounts"] if not a["is_primary"])
    assert (
        client.delete(f"/api/lichess/{primary['id']}", headers=csrf_headers(client)).status_code
        == 204
    )
    status = client.get("/api/lichess").json()
    assert status["username"] == other["username"]
    assert [a["username"] for a in status["accounts"] if a["is_primary"]] == [other["username"]]


def test_primary_and_unlink_reject_unknown_account(client):
    _register(client, "unknown@example.com")
    assert _run_link_flow(client).status_code == 303
    assert (
        client.post(
            "/api/lichess/primary",
            json={"account_id": "nope"},
            headers=csrf_headers(client),
        ).status_code
        == 404
    )
    assert (
        client.delete("/api/lichess/nope", headers=csrf_headers(client)).status_code == 404
    )
