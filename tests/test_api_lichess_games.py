"""Phase 2b-2d-iv: ported Lichess import/compare endpoints (network mocked).

Lichess's public games API needs no token, only a username, so compare/latest operate
on the caller's *linked* account (``LinkedAccount.provider_user_id``). Comparison is
owner-scoped (the caller's own repertoires only) and the "new game" marker is per-owner.
The OAuth link + the Lichess game fetch are both mocked — these tests exercise the
endpoint wiring (gating, link requirement, owner scoping, payload shape, upstream-error
mapping), not real network.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from api_helpers import csrf_headers
from prepforge_chess.services.lichess_fetch import FetchedGame, LichessFetchError

_PGN = """[Event "Rated Blitz game"]
[Site "https://lichess.org/abc123"]
[White "TestUser"]
[Black "Opponent"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0
"""


def _game(lichess_id: str = "abc123") -> FetchedGame:
    return FetchedGame(
        pgn=_PGN,
        white="TestUser",
        black="Opponent",
        result="1-0",
        lichess_id=lichess_id,
        event="Rated Blitz game",
        finished_at="2026-06-08T00:00:00Z",
    )


@pytest.fixture(autouse=True)
def _mock_oauth(monkeypatch):
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.exchange_code",
        lambda **kw: {"access_token": "lichess-tok", "token_type": "Bearer"},
    )
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username",
        lambda token, **kw: "TestUser",
    )


def _mock_fetch(monkeypatch, games=None, error: str | None = None):
    """Patch the source module so both the router's direct calls and
    ``compare_recent_games``'s internal call resolve to the stub."""

    def _fake(*args, **kwargs):
        if error is not None:
            raise LichessFetchError(error)
        return list(games or [])

    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_recent_pgns", _fake)
    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_latest_games_meta", _fake)


def _register(client, email):
    client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )


def _link(client):
    r = client.get("/api/lichess/login", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    cb = client.get(f"/api/lichess/callback?code=abc&state={state}", follow_redirects=False)
    assert cb.status_code == 303, cb.text


# ---- gating + link requirement ---------------------------------------------


def test_compare_requires_auth(client):
    assert client.get("/api/lichess/compare").status_code == 401


def test_latest_requires_auth(client):
    assert client.get("/api/lichess/latest").status_code == 401


def test_compare_requires_a_linked_account(client):
    _register(client, "a@example.com")
    assert client.get("/api/lichess/compare").status_code == 400


def test_latest_requires_a_linked_account(client):
    _register(client, "a@example.com")
    assert client.get("/api/lichess/latest").status_code == 400


# ---- compare ---------------------------------------------------------------


def test_compare_returns_owner_scoped_summaries(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])

    body = client.get("/api/lichess/compare").json()
    assert body["username"] == "TestUser"
    assert body["count"] == 1
    g = body["games"][0]
    assert g["lichess_id"] == "abc123"
    assert g["user_color"] == "white"
    assert g["move_san_history"] == ["e4", "e5", "Nf3", "Nc6"]
    # No repertoire yet -> not in book.
    assert g["in_repertoire"] is False
    assert g["departure_reason"] == "no_repertoire_for_color"


def test_compare_matches_against_owner_repertoire(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    # Build a white repertoire whose mainline opens 1.e4 so the game is in book.
    created = client.post(
        "/api/repertoires/create",
        json={"name": "King's Pawn", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": created["repertoire_id"],
            "parent_node_id": created["selected_node_id"],
            "move_uci": "e2e4",
        },
        headers=csrf_headers(client),
    )
    _mock_fetch(monkeypatch, games=[_game()])

    g = client.get("/api/lichess/compare").json()["games"][0]
    assert g["in_repertoire"] is True
    assert g["matched_plies"] >= 1
    assert g["repertoire_name"] == "King's Pawn"


def test_compare_maps_upstream_failure_to_502(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, error="Lichess responded with HTTP 429 for user TestUser")
    assert client.get("/api/lichess/compare").status_code == 502


# ---- latest watcher + seen -------------------------------------------------


def test_latest_no_games(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[])
    assert client.get("/api/lichess/latest").json() == {"has_game": False}


def test_latest_is_new_then_marked_seen(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])

    first = client.get("/api/lichess/latest").json()
    assert first["has_game"] is True
    assert first["is_new"] is True
    assert "pgn" in first and first["finished_at"] == "2026-06-08T00:00:00Z"

    # Acknowledge it -> no longer new.
    r = client.post(
        "/api/lichess/seen", json={"lichess_id": "abc123"}, headers=csrf_headers(client)
    )
    assert r.status_code == 200
    assert client.get("/api/lichess/latest").json()["is_new"] is False


def test_latest_light_probe_omits_pgn(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])
    body = client.get("/api/lichess/latest", params={"include_moves": False}).json()
    assert body["has_game"] is True
    assert "pgn" not in body


def test_seen_requires_csrf(client):
    _register(client, "a@example.com")
    _link(client)
    assert client.post("/api/lichess/seen", json={"lichess_id": "x"}).status_code == 403


# ---- legacy SPA compatibility surface --------------------------------------
# web-src/app.js still calls the old endpoints; these shims keep the SPA working
# across the FastAPI cutover (see the P1/P2 peer-review findings).


def test_status_shim_unlinked_shape(client):
    _register(client, "a@example.com")
    assert client.get("/api/lichess/status").json() == {"connected": False, "username": None}


def test_status_shim_linked_shape(client):
    _register(client, "a@example.com")
    _link(client)
    assert client.get("/api/lichess/status").json() == {
        "connected": True,
        "username": "TestUser",
    }


def test_status_shim_requires_auth(client):
    assert client.get("/api/lichess/status").status_code == 401


def test_compare_post_ignores_client_username(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])
    body = client.post(
        "/api/lichess/compare",
        json={"username": "someone-else", "count": 5},
        headers=csrf_headers(client),
    ).json()
    # username comes from the linked account, NOT the client-supplied one.
    assert body["username"] == "TestUser"
    assert body["count"] == 1


def test_compare_post_requires_csrf(client):
    _register(client, "a@example.com")
    _link(client)
    assert client.post("/api/lichess/compare", json={"count": 5}).status_code == 403


def test_latest_light_query_maps_to_metadata(client, monkeypatch):
    """The watcher hits ?light=1; it must omit the PGN but keep finished_at so the
    recency gate works (legacy mapped light -> include_moves=False)."""
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])
    body = client.get("/api/lichess/latest", params={"light": 1}).json()
    assert body["has_game"] is True
    assert "pgn" not in body
    assert body["finished_at"] == "2026-06-08T00:00:00Z"


def test_oauth_login_legacy_path_redirects(client):
    """The SPA opens /oauth/login in a popup; it must not 404 post-cutover."""
    _register(client, "a@example.com")
    r = client.get("/oauth/login", follow_redirects=False)
    assert r.status_code == 307
    assert "lichess.org" in r.headers["location"]


def test_oauth_login_legacy_path_requires_auth(client):
    assert client.get("/oauth/login", follow_redirects=False).status_code == 401


# ---- multi-tenant isolation ------------------------------------------------


def test_seen_marker_is_per_owner(client, monkeypatch):
    """B acknowledging a game id must not clear A's 'new' flag."""
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])

    # A acknowledges abc123.
    client.post("/api/lichess/seen", json={"lichess_id": "abc123"}, headers=csrf_headers(client))
    assert client.get("/api/lichess/latest").json()["is_new"] is False

    from prepforge_chess.api import main
    from fastapi.testclient import TestClient

    other = TestClient(main.app)
    _register(other, "b@example.com")
    # B links a DIFFERENT Lichess identity (the same one is refused with 409).
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username", lambda token, **kw: "UserB"
    )
    _link(other)
    # B has its own (empty) last-seen marker -> the same game is still new for B.
    assert other.get("/api/lichess/latest").json()["is_new"] is True
