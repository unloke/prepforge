"""Phase 2b-2d-iii: ported settings endpoint (per-owner preferences).

The only persistent preference in the browser-compute model is the Stockfish analysis
depth. Unlike the legacy single-tenant server (global ``app_settings``), the SaaS API
stores it **per owner** on ``user_profiles.settings_json`` — so these tests prove both
the round-trip and the multi-tenant isolation, plus that ``/api/analyze/prepare`` echoes
the owner's configured depth.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def _register(client: TestClient, email: str) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _set_depth(client: TestClient, depth) -> "object":
    return client.post(
        "/api/settings", json={"stockfish_depth": depth}, headers=csrf_headers(client)
    )


# ---- gating ----------------------------------------------------------------


def test_get_settings_requires_auth(client):
    assert client.get("/api/settings").status_code == 401


def test_post_settings_requires_csrf(client):
    _register(client, "a@example.com")
    assert client.post("/api/settings", json={"stockfish_depth": 20}).status_code == 403


def test_post_settings_requires_auth(client):
    r = client.post("/api/settings", json={"stockfish_depth": 20}, headers=csrf_headers(client))
    assert r.status_code == 401


# ---- read defaults + round-trip --------------------------------------------


def test_get_settings_returns_defaults(client):
    _register(client, "a@example.com")
    body = client.get("/api/settings").json()
    assert body["stockfish_depth"] == body["stockfish_depth_range"]["default"]
    assert body["stockfish_depth_range"]["min"] >= 1
    assert body["compute"] == "browser"


def test_post_settings_persists_depth(client):
    _register(client, "a@example.com")
    r = _set_depth(client, 22)
    assert r.status_code == 200, r.text
    assert r.json()["stockfish_depth"] == 22
    # Persisted across requests.
    assert client.get("/api/settings").json()["stockfish_depth"] == 22


def test_post_settings_clamps_out_of_range(client):
    _register(client, "a@example.com")
    rng = client.get("/api/settings").json()["stockfish_depth_range"]
    assert _set_depth(client, 9999).json()["stockfish_depth"] == rng["max"]
    assert _set_depth(client, -5).json()["stockfish_depth"] == rng["min"]


def test_post_settings_noop_without_depth(client):
    _register(client, "a@example.com")
    _set_depth(client, 12)
    # Omitting stockfish_depth leaves the stored value untouched.
    r = client.post("/api/settings", json={}, headers=csrf_headers(client))
    assert r.status_code == 200
    assert r.json()["stockfish_depth"] == 12


def test_post_settings_rejects_non_integer_depth(client):
    """StrictInt rejects bool/float/string outright (422) rather than silently
    coercing (``true`` -> 1, ``16.5`` -> 16), which would corrupt the stored depth."""
    _register(client, "a@example.com")
    assert _set_depth(client, True).status_code == 422
    assert _set_depth(client, 16.5).status_code == 422
    assert _set_depth(client, "deep").status_code == 422


# ---- maia rating (pinned strength vs auto/match-the-player) -----------------


def _set_maia(client: TestClient, rating) -> "object":
    return client.post(
        "/api/settings", json={"maia_rating": rating}, headers=csrf_headers(client)
    )


def test_maia_rating_defaults_to_auto(client):
    _register(client, "a@example.com")
    body = client.get("/api/settings").json()
    assert body["maia_rating"] is None
    assert body["maia_rating_range"] == {"min": 600, "max": 2600}


def test_maia_rating_round_trip_and_auto_reset(client):
    _register(client, "a@example.com")
    assert _set_maia(client, 1740).json()["maia_rating"] == 1740
    assert client.get("/api/settings").json()["maia_rating"] == 1740
    # "auto" clears the pin back to match-the-player.
    assert _set_maia(client, "auto").json()["maia_rating"] is None
    assert client.get("/api/settings").json()["maia_rating"] is None


def test_maia_rating_clamps_and_rejects_junk(client):
    _register(client, "a@example.com")
    rng = client.get("/api/settings").json()["maia_rating_range"]
    assert _set_maia(client, 99999).json()["maia_rating"] == rng["max"]
    assert _set_maia(client, 1).json()["maia_rating"] == rng["min"]
    # StrictInt | "auto": bool/float/other strings are 422s, not silent coercions.
    assert _set_maia(client, True).status_code == 422
    assert _set_maia(client, 1700.5).status_code == 422
    assert _set_maia(client, "strong").status_code == 422


def test_maia_rating_does_not_touch_depth(client):
    _register(client, "a@example.com")
    _set_depth(client, 12)
    _set_maia(client, 2000)
    body = client.get("/api/settings").json()
    assert body["stockfish_depth"] == 12
    assert body["maia_rating"] == 2000


# ---- multi-tenant isolation ------------------------------------------------


def test_depth_is_per_owner(client):
    _register(client, "a@example.com")
    assert _set_depth(client, 28).json()["stockfish_depth"] == 28

    other = _client()
    _register(other, "b@example.com")
    # B's depth is unaffected by A's write.
    default = other.get("/api/settings").json()["stockfish_depth_range"]["default"]
    assert other.get("/api/settings").json()["stockfish_depth"] == default


# ---- analyze prepare echoes the configured depth ---------------------------

_PGN = '[Event "T"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 *\n'


def test_prepare_echoes_owner_depth(client):
    _register(client, "a@example.com")
    _set_depth(client, 9)
    prepared = client.post(
        "/api/analyze/prepare", json={"pgn": _PGN}, headers=csrf_headers(client)
    ).json()
    assert prepared["depth"] == 9
