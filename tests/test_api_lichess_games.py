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


def _self_game_for(username):
    """A compare-ready game where `username` is a player (white)."""
    game = _game()
    game.white = username
    game.black = "Opponent"
    return game


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
    status = client.get("/api/lichess").json()
    accounts = status.get("accounts") or []
    assert accounts, status
    return accounts[0]["id"]


# ---- gating + link requirement ---------------------------------------------


def test_compare_requires_auth(client):
    assert client.get("/api/lichess/compare").status_code == 401


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("names,count", [(9, 10), (5, 50)])
def test_compare_rejects_upstream_amplification(client, monkeypatch, method, names, count):
    _register(client, "budget@example.com")
    calls = []
    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
                        lambda *a, **k: calls.append(1) or [])
    usernames = [f"user{i}" for i in range(names)]
    if method == "GET":
        response = client.get("/api/lichess/compare", params={"usernames": ",".join(usernames), "count": count})
    else:
        response = client.post("/api/lichess/compare", json={"usernames": usernames, "count": count},
                               headers=csrf_headers(client))
    assert response.status_code == 422
    assert calls == []


def test_compare_get_and_post_share_client_limit(client, monkeypatch):
    from prepforge_chess.api.ratelimit import limiter

    _register(client, "limited@example.com")
    _mock_fetch(monkeypatch)
    monkeypatch.setattr(limiter, "enabled", True)
    for _ in range(3):
        assert client.get("/api/lichess/compare", params={"usernames": "user"}).status_code == 200
        assert client.post("/api/lichess/compare", json={"usernames": ["user"]},
                           headers=csrf_headers(client)).status_code == 200
    assert client.get("/api/lichess/compare", params={"usernames": "user"}).status_code == 429


def test_games_429_has_retry_after(client, monkeypatch):
    from prepforge_chess.services.lichess_fetch import GamesRateLimitedError

    _register(client, "cooldown@example.com")
    _link(client)

    def limited(*a, **k):
        raise GamesRateLimitedError(60)

    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_recent_pgns", limited)
    for path in ["compare", "latest"]:
        response = client.get(f"/api/lichess/{path}")
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"


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


def test_compare_external_only_selection_never_rides_self_along(client, monkeypatch):
    """External-only source pick (every linked account unpicked): the compare
    fetch resolves ONLY the external usernames — Self accounts must not be
    re-added server-side (regression for the external-only round-trip)."""
    _register(client, "a@example.com")
    _link(client)
    fetched_for = []

    def _fake(*args, **kwargs):
        fetched_for.append(args[0])
        return []

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns", _fake
    )
    body = client.post(
        "/api/lichess/compare",
        json={"count": 5, "account_ids": [], "usernames": ["Hikaru"]},
        headers=csrf_headers(client),
    ).json()
    assert fetched_for == ["Hikaru"]  # linked "TestUser" is NOT fetched
    assert body["username"] == "Hikaru"

    # Absent account_ids keeps the self default (all linked accounts).
    fetched_for.clear()
    client.post(
        "/api/lichess/compare",
        json={"count": 5, "usernames": ["Hikaru"]},
        headers=csrf_headers(client),
    )
    assert sorted(fetched_for) == ["Hikaru", "TestUser"]


# ---- opening explorer proxy --------------------------------------------------

_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
_EXPLORER_RAW = {
    "white": 10,
    "draws": 5,
    "black": 5,
    "moves": [{"uci": "e2e4", "san": "e4", "white": 10, "draws": 5, "black": 5}],
}


@pytest.fixture(autouse=True)
def _clear_explorer_cache():
    from prepforge_chess.api.routers import lichess as lichess_router

    lichess_router._explorer_cache.clear()
    yield
    lichess_router._explorer_cache.clear()


def test_explorer_requires_auth(client):
    assert client.get(f"/api/lichess/explorer/masters?fen={_START_FEN}").status_code == 401


def test_explorer_unknown_db_is_404(client):
    _register(client, "a@example.com")
    assert client.get(f"/api/lichess/explorer/bogus?fen={_START_FEN}").status_code == 404


def test_explorer_requires_link(client):
    _register(client, "a@example.com")
    r = client.get("/api/lichess/explorer/masters", params={"fen": _START_FEN})
    assert r.status_code == 400
    assert "link your lichess" in r.json()["detail"].lower()


def test_explorer_proxies_with_token_and_caches(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    calls = []

    def _fake_fetch(url, token, **kwargs):
        calls.append((url, token))
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    first = client.get("/api/lichess/explorer/masters", params={"fen": _START_FEN})
    assert first.status_code == 200, first.text
    assert first.json()["moves"][0]["san"] == "e4"
    # The linked token rode along server-side.
    assert calls and calls[0][1] == "lichess-tok"
    # Second hit is served from the in-process cache: no upstream call.
    second = client.get("/api/lichess/explorer/masters", params={"fen": _START_FEN})
    assert second.status_code == 200
    assert len(calls) == 1


def test_explorer_validates_ratings_and_pins_params(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    seen = {}

    def _fake_fetch(url, token, **kwargs):
        seen["url"] = url
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    r = client.get(
        "/api/lichess/explorer/lichess",
        params={"fen": _START_FEN, "ratings": "1800,evil,99"},
    )
    assert r.status_code == 200
    # Junk buckets dropped, upstream params pinned server-side.
    assert "ratings=1800" in seen["url"] and "evil" not in seen["url"]
    assert "speeds=blitz%2Crapid%2Cclassical" in seen["url"]
    assert "variant=standard" in seen["url"]


def test_explorer_passes_through_rate_limit(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)

    def _fake_fetch(url, token, **kwargs):
        from prepforge_chess.services.lichess_fetch import ExplorerRateLimitedError

        raise ExplorerRateLimitedError("explorer rate limit")

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    r = client.get("/api/lichess/explorer/masters", params={"fen": _START_FEN})
    assert r.status_code == 429


def test_explorer_masters_top_games_passthrough(client, monkeypatch):
    _register(client, "top1@example.com")
    _link(client)
    seen = {}

    def _fake_fetch(url, token, **kwargs):
        seen["url"] = url
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    r = client.get(
        "/api/lichess/explorer/masters",
        params={"fen": _START_FEN, "top_games": 4},
    )
    assert r.status_code == 200, r.text
    assert "topGames=4" in seen["url"]


def test_explorer_masters_top_games_clamped(client, monkeypatch):
    _register(client, "top2@example.com")
    _link(client)
    seen = {}

    def _fake_fetch(url, token, **kwargs):
        seen["url"] = url
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    from prepforge_chess.api.routers import lichess as lichess_router

    r = client.get(
        "/api/lichess/explorer/masters",
        params={"fen": _START_FEN, "top_games": 99},
    )
    assert r.status_code == 200, r.text
    assert "topGames=4" in seen["url"]
    lichess_router._explorer_cache.clear()

    r = client.get(
        "/api/lichess/explorer/masters",
        params={"fen": _START_FEN, "top_games": -3},
    )
    assert r.status_code == 200, r.text
    assert "topGames=0" in seen["url"]


def test_explorer_lichess_ignores_top_games(client, monkeypatch):
    _register(client, "top3@example.com")
    _link(client)
    seen = {}

    def _fake_fetch(url, token, **kwargs):
        seen["url"] = url
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    r = client.get(
        "/api/lichess/explorer/lichess",
        params={"fen": _START_FEN, "top_games": 4},
    )
    assert r.status_code == 200, r.text
    assert "topGames" not in seen["url"]
    assert "speeds=blitz%2Crapid%2Cclassical" in seen["url"]
    assert "variant=standard" in seen["url"]


def test_explorer_masters_default_top_games_zero(client, monkeypatch):
    _register(client, "top4@example.com")
    _link(client)
    seen = {}

    def _fake_fetch(url, token, **kwargs):
        seen["url"] = url
        return dict(_EXPLORER_RAW)

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fake_fetch
    )
    r = client.get("/api/lichess/explorer/masters", params={"fen": _START_FEN})
    assert r.status_code == 200, r.text
    assert "topGames=0" in seen["url"]


# ---- departure -> training miss (play→train loop) ---------------------------

_DEPARTURE_PGN = """[Event "Rated Blitz game"]
[Site "https://lichess.org/dep001"]
[White "TestUser"]
[Black "Opponent"]
[Result "0-1"]

1. d4 d5 0-1
"""


def _departure_game() -> FetchedGame:
    return FetchedGame(
        pgn=_DEPARTURE_PGN,
        white="TestUser",
        black="Opponent",
        result="0-1",
        lichess_id="dep001",
        event="Rated Blitz game",
        finished_at="2026-06-08T00:00:00Z",
    )


def _make_e4_repertoire(client) -> dict:
    created = client.post(
        "/api/repertoires/create",
        json={"name": "King's Pawn", "color": "white"},
        headers=csrf_headers(client),
    ).json()
    add = client.post(
        "/api/build/add-move",
        json={
            "repertoire_id": created["repertoire_id"],
            "parent_node_id": created["selected_node_id"],
            "move_uci": "e2e4",
        },
        headers=csrf_headers(client),
    ).json()
    return {"repertoire_id": created["repertoire_id"], "add": add}


def test_departure_records_training_miss_once(client, monkeypatch):
    """A game where the user left their own prep (played 1.d4 with an 1.e4 book)
    becomes ONE recall miss on the expected node — due immediately — and re-running
    compare on the same game does not double-count."""
    _register(client, "a@example.com")
    _link(client)
    rep = _make_e4_repertoire(client)
    _mock_fetch(monkeypatch, games=[_departure_game()])

    body = client.get("/api/lichess/compare").json()
    g = body["games"][0]
    assert g["departure_reason"] == "user_left_preparation"
    assert g["expected_move_san"] == "e4"
    assert g["training_recorded"] is True
    assert body["misses_recorded"] == 1

    # The miss is visible to the trainer: the repertoire now has a due review.
    summary = client.get(
        "/api/train/smart/summary", params={"repertoire_id": rep["repertoire_id"]}
    ).json()
    assert summary["health"]["due"] >= 1 or summary["health"]["weak"] >= 1

    # Same game again -> deduped, nothing recorded.
    again = client.get("/api/lichess/compare").json()
    assert again["misses_recorded"] == 0
    assert again["games"][0]["training_recorded"] is False


def test_opponent_novelty_records_nothing(client, monkeypatch):
    """The OPPONENT leaving book is not a recall miss — nothing to drill."""
    _register(client, "a@example.com")
    _link(client)
    _make_e4_repertoire(client)
    pgn = _PGN.replace("1. e4 e5 2. Nf3 Nc6", "1. e4 d5")  # 1...d5 not in book
    _mock_fetch(
        monkeypatch,
        games=[
            FetchedGame(
                pgn=pgn,
                white="TestUser",
                black="Opponent",
                result="1-0",
                lichess_id="nov001",
                event="Rated Blitz game",
                finished_at="2026-06-08T00:00:00Z",
            )
        ],
    )
    body = client.get("/api/lichess/compare").json()
    assert body["games"][0]["departure_reason"] == "opponent_unprepared_branch"
    assert body["misses_recorded"] == 0


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


# ---- canonical Lichess surface (GET /api/lichess) ----------------------------


def test_status_unlinked_shape(client):
    _register(client, "a@example.com")
    assert client.get("/api/lichess").json() == {
        "linked": False,
        "username": None,
        "accounts": [],
    }


def test_status_linked_shape(client):
    _register(client, "a@example.com")
    link_id = _link(client)
    assert client.get("/api/lichess").json() == {
        "linked": True,
        "username": "TestUser",
        "accounts": [{"id": link_id, "username": "TestUser", "is_primary": True}],
    }


def test_status_requires_auth(client):
    assert client.get("/api/lichess").status_code == 401


def test_compare_post_uses_linked_identity(client, monkeypatch):
    _register(client, "a@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])
    body = client.post(
        "/api/lichess/compare",
        json={"count": 5},
        headers=csrf_headers(client),
    ).json()
    # username comes from the linked account, NOT any client-supplied one.
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


def test_oauth_login_redirects(client):
    """The SPA opens /api/lichess/login in a popup; it must redirect to Lichess."""
    _register(client, "a@example.com")
    r = client.get("/api/lichess/login", follow_redirects=False)
    assert r.status_code == 307
    assert "lichess.org" in r.headers["location"]


def test_oauth_login_requires_auth(client):
    assert client.get("/api/lichess/login", follow_redirects=False).status_code == 401


# ---- per-action account selection --------------------------------------------


def _link_as(client, monkeypatch, username):
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username",
        lambda token, **kw: username,
    )
    _link(client)


# ---- My last game: true newest across linked accounts (S1) ---------------------


def test_my_last_game_picks_true_newest_when_older_account_answers_first(
    client, monkeypatch
):
    """S1 regression: A is older, B is newer; even if A's response wins the
    race, the general My-last-game action (no account_id) loads B's game."""
    _register(client, "mylastgame@example.com")
    _link_as(client, monkeypatch, "MyOld")
    _link_as(client, monkeypatch, "MyNew")

    def _fake_meta(username, count=1, **kwargs):
        assert count == 1
        game = _game()
        game.white = username
        game.black = "Opponent"
        if username == "MyOld":
            game.lichess_id = "olderAAA"
            # Older account genuinely finished earlier.
            game.finished_at = "2026-06-07T00:00:00+00:00"
        else:
            game.lichess_id = "newerBBB"
            game.finished_at = "2026-06-08T00:00:00+00:00"
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_latest_games_meta",
        lambda username, count=1, **kwargs: _fake_meta(username, count, **kwargs),
    )

    # General action: no account_id anywhere in the request.
    body = client.get("/api/lichess/latest", params={"light": 1}).json()
    assert body["has_game"] is True
    assert body["lichess_id"] == "newerBBB"
    assert body["source_account"] == "MyNew"
    assert body["finished_at"] == "2026-06-08T00:00:00+00:00"


def test_my_last_game_true_newest_survives_reversed_completion_order(
    client, monkeypatch
):
    """S1 race regression: the newer account must win even when the older
    account's fetch completes first (bounded fan-out completion order must
    not decide the winner)."""
    import time

    import prepforge_chess.services.lichess_fetch as fetch_mod

    _register(client, "mylastgamerace@example.com")
    _link_as(client, monkeypatch, "RaceOld")
    _link_as(client, monkeypatch, "RaceNew")

    def _fake_meta(username, count=1, **kwargs):
        game = _game()
        game.white = username
        game.black = "Opponent"
        if username == "RaceOld":
            game.lichess_id = "race-older"
            game.finished_at = "2026-06-07T00:00:00+00:00"
            return [game]
        # Newer account is slower to answer — it must still win.
        time.sleep(0.05)
        game.lichess_id = "race-newer"
        game.finished_at = "2026-06-08T00:00:00+00:00"
        return [game]

    monkeypatch.setattr(fetch_mod, "fetch_latest_games_meta", _fake_meta)

    game, source = fetch_mod.newest_game_across(["RaceOld", "RaceNew"])
    assert game.lichess_id == "race-newer"
    assert source == "RaceNew"


def test_my_last_game_pgn_path_picks_true_newest_by_end_timestamp(
    client, monkeypatch
):
    """S1 regression: the full-PGN My-last-game path must also rank by the
    canonical finished/end timestamp (not response or account order)."""
    _register(client, "mylastgamepgn@example.com")
    _link_as(client, monkeypatch, "PgnOld")
    _link_as(client, monkeypatch, "PgnNew")

    def _fake_pgn(username, count=1, **kwargs):
        game = _game()
        game.white = username
        if username == "PgnOld":
            game.lichess_id = "pgn-older"
            game.finished_at = "2026-06-07T00:00:00+00:00"
        else:
            game.lichess_id = "pgn-newer"
            game.finished_at = "2026-06-08T00:00:00+00:00"
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake_pgn(username, count, **kwargs),
    )
    body = client.get("/api/lichess/latest").json()
    assert body["has_game"] is True
    assert body["lichess_id"] == "pgn-newer"
    assert body["source_account"] == "PgnNew"
    assert "pgn" in body


def test_latest_default_aggregates_self_and_picks_newest(client, monkeypatch):
    """Two linked identities, no account_id: the default reads BOTH and loads
    the truly newest by finish time, quietly naming the source account."""
    _register(client, "selfagg@example.com")
    _link_as(client, monkeypatch, "SelfA")
    _link_as(client, monkeypatch, "SelfB")

    def _fake_meta(username, count=1, **kwargs):
        game = _game()
        game.white = username
        game.black = "Opponent"
        if username == "SelfA":
            game.lichess_id = "older001"
            game.finished_at = "2026-06-07T00:00:00Z"
        else:
            game.lichess_id = "newer002"
            game.finished_at = "2026-06-08T00:00:00Z"
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_latest_games_meta",
        lambda username, count=1, **kwargs: _fake_meta(username, count, **kwargs),
    )

    body = client.get("/api/lichess/latest", params={"light": 1}).json()
    assert body["has_game"] is True
    assert body["lichess_id"] == "newer002"
    assert body["source_account"] == "SelfB"
    # Primary is untouched: aggregation never reassigns it.
    assert client.get("/api/lichess").json()["username"] == "SelfA"


def test_latest_aggregates_with_moves_for_my_last_game(client, monkeypatch):
    """The full-PGN path (My last game) also aggregates: newest PGN wins."""
    _register(client, "selfpgn@example.com")
    _link_as(client, monkeypatch, "PgnA")
    _link_as(client, monkeypatch, "PgnB")

    def _fake_pgn(username, count=1, **kwargs):
        game = _game()
        game.white = username
        if username == "PgnA":
            game.lichess_id = "pgn-old"
            game.finished_at = "2026-06-07T00:00:00+00:00"
        else:
            game.lichess_id = "pgn-new"
            game.finished_at = "2026-06-08T00:00:00+00:00"
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake_pgn(username, count, **kwargs),
    )
    body = client.get("/api/lichess/latest").json()
    assert body["has_game"] is True
    assert body["lichess_id"] == "pgn-new"
    assert body["source_account"] == "PgnB"
    assert "pgn" in body


def test_latest_self_degrades_when_one_account_fails(client, monkeypatch):
    _register(client, "selfpart@example.com")
    _link_as(client, monkeypatch, "PartA")
    _link_as(client, monkeypatch, "PartB")

    def _fake_meta(username, count=1, **kwargs):
        if username == "PartA":
            raise LichessFetchError("Lichess responded with HTTP 429 for user PartA")
        return [_game()]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_latest_games_meta",
        lambda username, count=1, **kwargs: _fake_meta(username, count, **kwargs),
    )
    body = client.get("/api/lichess/latest", params={"light": 1}).json()
    assert body["has_game"] is True
    assert body["source_account"] == "PartB"


def test_latest_self_all_fail_maps_to_502(client, monkeypatch):
    _register(client, "selfallfail@example.com")
    _link_as(client, monkeypatch, "FailA")
    _link_as(client, monkeypatch, "FailB")
    _mock_fetch(monkeypatch, error="Lichess is down")
    assert client.get("/api/lichess/latest", params={"light": 1}).status_code == 502


def test_two_identities_coexist_and_latest_selects_each(client, monkeypatch):
    """Link A then B: both appear in Settings, latest reads either by account_id."""
    _register(client, "chooser@example.com")
    _link_as(client, monkeypatch, "ChooserA")
    _link_as(client, monkeypatch, "ChooserB")

    status = client.get("/api/lichess").json()
    assert {a["username"] for a in status["accounts"]} == {"ChooserA", "ChooserB"}
    assert [a["username"] for a in status["accounts"] if a["is_primary"]] == ["ChooserA"]
    second = next(a for a in status["accounts"] if a["username"] == "ChooserB")

    seen = []

    def _fake(username, count=1, **kwargs):
        seen.append(username)
        game = _game()
        game.white = username
        game.black = "Opponent"
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake(username, count, **kwargs),
    )
    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_latest_games_meta",
        lambda username, count=1, **kwargs: _fake(username, count, **kwargs),
    )

    # Default (no account_id) aggregates self: both identities are read.
    body = client.get("/api/lichess/latest").json()
    assert body["white"] in ("ChooserA", "ChooserB")
    assert body["source_account"] in ("ChooserA", "ChooserB")
    # Explicit selection reads B without changing the primary.
    assert (
        client.get("/api/lichess/latest", params={"account_id": second["id"]}).json()["white"]
        == "ChooserB"
    )
    assert client.get("/api/lichess").json()["username"] == "ChooserA"
    assert sorted(seen) == ["ChooserA", "ChooserB", "ChooserB"]


def test_compare_selects_second_identity_without_changing_primary(client, monkeypatch):
    _register(client, "comparechooser@example.com")
    _link_as(client, monkeypatch, "CompareA")
    _link_as(client, monkeypatch, "CompareB")
    second = next(
        a for a in client.get("/api/lichess").json()["accounts"] if a["username"] == "CompareB"
    )

    seen = []

    def _fake_compare(repo, username, count, owner_user_id=None):
        seen.append(username)
        return []

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.compare_recent_games", _fake_compare
    )
    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.record_departure_misses", lambda *a, **k: 0
    )

    body = client.post(
        "/api/lichess/compare",
        json={"count": 10, "account_id": second["id"]},
        headers=csrf_headers(client),
    ).json()
    assert body["username"] == "CompareB"
    assert seen == ["CompareB"]
    assert client.get("/api/lichess").json()["username"] == "CompareA"


def test_compare_default_aggregates_self_with_source_metadata(client, monkeypatch):
    """No account_id: both identities are read, games dedupe, each game names
    its source account, and the payload says self."""
    _register(client, "selfcompare@example.com")
    _link_as(client, monkeypatch, "SelfCmpA")
    _link_as(client, monkeypatch, "SelfCmpB")

    def _fake_pgn(username, count=1, **kwargs):
        game = _self_game_for(username)
        game.lichess_id = "game-{0}".format(username)
        return [game]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake_pgn(username, count, **kwargs),
    )
    body = client.post(
        "/api/lichess/compare",
        json={"count": 10},
        headers=csrf_headers(client),
    ).json()
    assert body["username"] == "self"
    assert body["count"] == 2
    assert sorted(body["sources"]) == ["SelfCmpA", "SelfCmpB"]
    assert {g["source_account"] for g in body["games"]} == {"SelfCmpA", "SelfCmpB"}
    assert client.get("/api/lichess").json()["username"] == "SelfCmpA"


def test_compare_explicit_subset_narrows_to_those_accounts(client, monkeypatch):
    _register(client, "subsetcompare@example.com")
    _link_as(client, monkeypatch, "SubA")
    _link_as(client, monkeypatch, "SubB")
    second = next(
        a for a in client.get("/api/lichess").json()["accounts"] if a["username"] == "SubB"
    )
    seen = []

    def _fake_pgn(username, count=1, **kwargs):
        seen.append(username)
        return [_self_game_for(username)]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake_pgn(username, count, **kwargs),
    )
    body = client.post(
        "/api/lichess/compare",
        json={"count": 10, "account_ids": [second["id"]]},
        headers=csrf_headers(client),
    ).json()
    assert body["username"] == "SubB"
    assert seen == ["SubB"]
    assert client.get("/api/lichess").json()["username"] == "SubA"


def test_compare_self_dedups_shared_game_ids(client, monkeypatch):
    _register(client, "dedupcompare@example.com")
    _link_as(client, monkeypatch, "DedupA")
    _link_as(client, monkeypatch, "DedupB")
    same = _game()
    same.white = "DedupA"
    same.black = "DedupB"
    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: [same],
    )
    body = client.post(
        "/api/lichess/compare",
        json={"count": 10},
        headers=csrf_headers(client),
    ).json()
    assert body["count"] == 1


def test_compare_self_partial_failure_still_returns_games(client, monkeypatch):
    _register(client, "partcompare@example.com")
    _link_as(client, monkeypatch, "PartCmpA")
    _link_as(client, monkeypatch, "PartCmpB")

    def _fake_pgn(username, count=1, **kwargs):
        if username == "PartCmpA":
            raise LichessFetchError("Lichess responded with HTTP 429 for user PartCmpA")
        return [_self_game_for("PartCmpB")]

    monkeypatch.setattr(
        "prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
        lambda username, count=1, **kwargs: _fake_pgn(username, count, **kwargs),
    )
    body = client.post(
        "/api/lichess/compare",
        json={"count": 10},
        headers=csrf_headers(client),
    ).json()
    assert body["count"] == 1
    assert body["games"][0]["source_account"] == "PartCmpB"
    assert body["source_errors"][0]["username"] == "PartCmpA"
    assert "429" in body["source_errors"][0]["message"]


def test_latest_rejects_unknown_account_id(client, monkeypatch):
    _register(client, "unknownacct@example.com")
    _link(client)
    _mock_fetch(monkeypatch, games=[_game()])
    assert client.get("/api/lichess/latest", params={"account_id": "nope"}).status_code == 404


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


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("linked", [False, True])
def test_external_departure_never_writes_training(client, monkeypatch, method, linked):
    from unittest.mock import patch
    from prepforge_chess.storage.repositories import PrepForgeRepository

    _register(client, "external-evidence@example.com")
    if linked:
        _link_as(client, monkeypatch, "OtherSelf")
    rep = _make_e4_repertoire(client)
    _mock_fetch(monkeypatch, games=[_departure_game()])
    before = client.get("/api/train/smart/summary", params={
        "repertoire_id": rep["repertoire_id"],
    }).json()
    with patch.object(PrepForgeRepository, "lock_user_setting") as ledger, patch.object(
        PrepForgeRepository, "write_training_progress"
    ) as progress:
        if method == "GET":
            response = client.get("/api/lichess/compare", params={
                "account_ids": "", "usernames": "TestUser",
            })
        else:
            response = client.post("/api/lichess/compare", json={
                "account_ids": [], "usernames": ["TestUser"],
            }, headers=csrf_headers(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["games"][0]["departure_reason"] == "user_left_preparation"
        assert body["misses_recorded"] == 0
        assert body["games"][0]["training_recorded"] is False
        progress.assert_not_called()
        ledger.assert_not_called()
    after = client.get("/api/train/smart/summary", params={
        "repertoire_id": rep["repertoire_id"],
    }).json()
    assert after == before


def _compare_selection(client, method, names):
    if method == "GET":
        response = client.get("/api/lichess/compare", params={
            "account_ids": "", "usernames": ",".join(names),
        })
    else:
        response = client.post("/api/lichess/compare", json={
            "account_ids": [], "usernames": names,
        }, headers=csrf_headers(client))
    assert response.status_code == 200, response.text
    return response.json()


def _evidence_repo():
    from sqlalchemy import select
    from prepforge_chess.api.db import get_engine
    from prepforge_chess.api.models import User
    from prepforge_chess.storage.repositories import PrepForgeRepository

    engine = get_engine()
    with engine.connect() as conn:
        owner = conn.execute(select(User.id)).scalar_one()
    return PrepForgeRepository(engine), owner


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("shared", [False, True])
def test_compare_identity_mixed_and_shared(client, monkeypatch, method, reverse, shared):
    from dataclasses import replace
    from prepforge_chess.services.lichess_fetch import DEPARTURE_INGESTED_KEY

    _register(client, "mixed-evidence@example.com")
    _link(client)
    rep = _make_e4_repertoire(client)
    own = _departure_game()
    external = replace(own, white="External", lichess_id="external001",
                       pgn=own.pgn.replace("TestUser", "External"))
    # Same actual game: external perspective is Black, self perspective is White.
    if shared:
        own.black = "External"
        own.pgn = own.pgn.replace("Opponent", "External")
    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_recent_pgns",
                        lambda name, *a, **k: [own if shared or name == "TestUser" else external])
    names = ["TestUser", "External"]
    if reverse:
        names.reverse()
    body = _compare_selection(client, method, names)
    assert body["misses_recorded"] == 1
    assert len(body["games"]) == (1 if shared else 2)
    own_result = next(g for g in body["games"] if g["lichess_id"] == "dep001")
    assert own_result["source_account"] == "TestUser"
    assert own_result["user_color"] == "white"
    assert own_result["training_recorded"] is True
    if not shared:
        ext = next(g for g in body["games"] if g["lichess_id"] == "external001")
        assert ext["departure_reason"] == "user_left_preparation"
        assert ext["training_recorded"] is False
    repo, owner = _evidence_repo()
    node = own_result["expected_node_id"]
    assert repo.load_training_progress(rep["repertoire_id"], node, owner_user_id=owner).attempts == 1
    assert repo.get_user_setting(owner, DEPARTURE_INGESTED_KEY) == ["dep001"]
    # Retry with the other order: same attribution, no second progress update.
    again = _compare_selection(client, method, list(reversed(names)))
    assert again["misses_recorded"] == 0
    assert next(g for g in again["games"] if g["lichess_id"] == "dep001")[
        "source_account"
    ] == "TestUser"
    assert repo.load_training_progress(rep["repertoire_id"], node, owner_user_id=owner).attempts == 1


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_external_compare_preserves_mastery_health_and_queue(client, monkeypatch, method):
    from datetime import datetime, timedelta, timezone
    from prepforge_chess.core.models import TrainingProgress
    from prepforge_chess.services.lichess_fetch import DEPARTURE_INGESTED_KEY

    _register(client, "mastery-evidence@example.com")
    rep = _make_e4_repertoire(client)
    repo, owner = _evidence_repo()
    node = rep["add"]["selected_node_id"]
    now = datetime.now(timezone.utc)
    repo.save_training_progress(rep["repertoire_id"], TrainingProgress(
        node_id=node, attempts=8, correct_attempts=8, is_mastered=True,
        spaced_repetition_score=8, last_reviewed_at=now, due_at=now + timedelta(days=5),
    ), owner_user_id=owner)
    saved = repo.load_training_progress(rep["repertoire_id"], node, owner_user_id=owner)
    params = {"repertoire_id": rep["repertoire_id"]}
    before = client.get("/api/train/smart/summary", params=params).json()
    def start():
        result = client.post("/api/train/smart/start", json={
            **params, "fresh": True, "seed": 42,
        }, headers=csrf_headers(client))
        return result.status_code, result.json()
    queue_before = start()
    assert queue_before[0] == 200, queue_before
    assert queue_before[1]["cards"]
    _mock_fetch(monkeypatch, games=[_departure_game()])
    body = _compare_selection(client, method, ["TestUser"])
    assert body["misses_recorded"] == 0
    assert repo.load_training_progress(rep["repertoire_id"], node, owner_user_id=owner) == saved
    assert repo.get_user_setting(owner, DEPARTURE_INGESTED_KEY) is None
    assert client.get("/api/train/smart/summary", params=params).json() == before
    queue_after = start()
    assert queue_after[0] == queue_before[0]
    # Both calls explicitly rebuild. Only the logical session generation
    # changes; external comparisons must still leave every queue fact intact.
    assert queue_after[1].pop("session_generation") != queue_before[1].pop("session_generation")
    assert queue_after[1] == queue_before[1]


def test_record_miss_is_explicit_adoption_without_link(client, monkeypatch):
    from prepforge_chess.services.lichess_fetch import DEPARTURE_INGESTED_KEY

    _register(client, "adopt-evidence@example.com")
    rep = _make_e4_repertoire(client)
    _mock_fetch(monkeypatch, games=[_departure_game()])
    body = _compare_selection(client, "POST", ["TestUser"])
    assert body["misses_recorded"] == 0
    node = body["games"][0]["expected_node_id"]
    for _ in range(2):
        response = client.post("/api/train/record-miss", json={
            "repertoire_id": rep["repertoire_id"], "node_id": node,
        }, headers=csrf_headers(client))
        assert response.status_code == 200, response.text
        assert response.json() == {"recorded": True, "node_id": node}
    repo, owner = _evidence_repo()
    progress = repo.load_training_progress(rep["repertoire_id"], node, owner_user_id=owner)
    assert progress.attempts == 2  # Each explicit click is a new miss.
    assert progress.due_at == progress.last_reviewed_at
    assert repo.get_user_setting(owner, DEPARTURE_INGESTED_KEY) is None
    assert client.post("/api/train/record-miss", json={
        "repertoire_id": rep["repertoire_id"], "node_id": "missing",
    }, headers=csrf_headers(client)).status_code == 404


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_external_then_linked_retry_is_not_poisoned(client, monkeypatch, method):
    _register(client, "later-linked@example.com")
    _make_e4_repertoire(client)
    _mock_fetch(monkeypatch, games=[_departure_game()])
    assert _compare_selection(client, method, ["testuser"])["misses_recorded"] == 0
    _link(client)
    assert _compare_selection(client, method, ["testuser"])["misses_recorded"] == 1
    assert _compare_selection(client, method, ["TESTUSER"])["misses_recorded"] == 0


def test_record_miss_rejects_other_owners_repertoire(client):
    from fastapi.testclient import TestClient
    from prepforge_chess.api import main

    _register(client, "record-owner@example.com")
    rep = _make_e4_repertoire(client)
    other = TestClient(main.app)
    _register(other, "record-other@example.com")
    assert other.post("/api/train/record-miss", json={
        "repertoire_id": rep["repertoire_id"], "node_id": rep["add"]["selected_node_id"],
    }, headers=csrf_headers(other)).status_code == 404


def test_compare_many_identities_returns_newest_n_across_accounts(monkeypatch):
    """"Last 10" across two linked accounts is the newest 10 overall, not 5 + 5."""
    from prepforge_chess.services import lichess_fetch as fetch_mod

    def _games_for(username, stamps):
        out = []
        for i, stamp in enumerate(stamps):
            g = _game(f"{username}{i}")
            g.white = username
            g.finished_at = stamp
            out.append(g)
        return out

    # Account A played its 8 games most recently; B's 8 games are all older.
    a = _games_for("alpha", [f"2026-09-2{9 - i // 2}T1{i}:00:00Z" for i in range(8)])
    b = _games_for("beta", [f"2026-08-{20 - i:02d}T10:00:00Z" for i in range(8)])
    requested = {}

    def _fake(username, count, **kwargs):
        requested[username] = count
        return list({"alpha": a, "beta": b}[username][:count])

    monkeypatch.setattr(fetch_mod, "fetch_recent_pgns", _fake)

    class _Repo:
        def list_repertoires(self, owner_user_id=None):
            return []

    pairs = fetch_mod.compare_many_identities(_Repo(), ["alpha", "beta"], 10)
    assert requested == {"alpha": 10, "beta": 10}
    assert len(pairs) == 10
    stamps = [s.finished_at for s, _ in pairs]
    assert stamps == sorted(stamps, reverse=True)
    assert [src for _, src in pairs].count("alpha") == 8
    assert [src for _, src in pairs].count("beta") == 2
