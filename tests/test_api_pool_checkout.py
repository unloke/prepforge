"""An authenticated request must never hold two pooled connections at once.

The auth dependency reads through the request's ORM session, and that session
autobegins a transaction that keeps its connection checked out until it ends.
Left open, every route then borrows a second connection for its own reads while
the first sits idle, so enough concurrent requests exhaust the pool waiting on
one another. The Lichess routes likewise must not keep a connection checked out
while they wait on Lichess.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import event

from api_helpers import csrf_headers
from prepforge_chess.services.lichess_fetch import FetchedGame

_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
_PGN = """[Event "Rated Blitz game"]
[Site "https://lichess.org/abc123"]
[White "TestUser"]
[Black "Opponent"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0
"""


class _Checkouts:
    def __init__(self, engine):
        self.now = 0
        self.peak = 0
        event.listen(engine, "checkout", self._out)
        event.listen(engine, "checkin", self._in)

    def _out(self, *_args):
        self.now += 1
        self.peak = max(self.peak, self.now)

    def _in(self, *_args):
        self.now -= 1

    def reset(self):
        self.peak = self.now


@pytest.fixture()
def signed_in(client):
    client.post(
        "/api/auth/register",
        json={"email": "pool@example.com", "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    from prepforge_chess.api import db

    return client, _Checkouts(db.get_engine())


@pytest.fixture()
def linked(signed_in, monkeypatch):
    client, checkouts = signed_in
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.exchange_code",
        lambda **kw: {"access_token": "lichess-tok", "token_type": "Bearer"},
    )
    monkeypatch.setattr(
        "prepforge_chess.api.routers.lichess.fetch_username", lambda token, **kw: "TestUser"
    )
    r = client.get("/api/lichess/login", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    cb = client.get(f"/api/lichess/callback?code=abc&state={state}", follow_redirects=False)
    assert cb.status_code == 303, cb.text
    return client, checkouts


@pytest.mark.parametrize("path", ["/api/analyses", "/api/repertoires", "/api/settings"])
def test_authenticated_read_holds_one_connection_at_a_time(signed_in, path):
    client, checkouts = signed_in
    checkouts.reset()
    assert client.get(path).status_code == 200
    assert checkouts.peak == 1


def test_explorer_waits_on_lichess_with_no_connection_out(linked, monkeypatch):
    client, checkouts = linked
    held = []

    async def _fetch(url, token, **kwargs):
        held.append(checkouts.now)
        return {"moves": []}, 2

    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_explorer_json", _fetch)
    r = client.get("/api/lichess/explorer/lichess", params={"fen": _START_FEN, "ratings": "2000"})
    assert r.status_code == 200, r.text
    assert held == [0]


def test_compare_and_latest_wait_on_lichess_with_no_connection_out(linked, monkeypatch):
    client, checkouts = linked
    held = []

    def _fetch(*args, **kwargs):
        held.append(checkouts.now)
        return [FetchedGame(pgn=_PGN, white="TestUser", black="Opponent", result="1-0",
                            lichess_id="abc123", event="Rated Blitz game",
                            finished_at="2026-06-08T00:00:00Z")]

    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_recent_pgns", _fetch)
    monkeypatch.setattr("prepforge_chess.services.lichess_fetch.fetch_latest_games_meta", _fetch)
    assert client.get("/api/lichess/compare", params={"count": 1}).status_code == 200
    assert client.get("/api/lichess/latest").status_code == 200
    assert held == [0, 0]
