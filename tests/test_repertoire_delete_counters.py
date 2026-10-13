"""Deleting a whole repertoire must not lower the dashboard's session or weekly
review counts: its rows are archived into the owner's counters first."""
from api_helpers import csrf_headers
from test_api_train import _register, _smart_move, _smart_start, _white_repertoire_with_e4


def _played_repertoire(client):
    rep = _white_repertoire_with_e4(client)
    sid = _smart_start(client, rep, seed=5).json()["session_id"]
    _smart_move(client, sid, "e2e4")
    return rep


def _delete(client, rep):
    r = client.post("/api/repertoires/delete", json={"repertoire_id": rep}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text


def test_deleting_repertoire_keeps_session_count(client):
    _register(client, "counts@example.com")
    rep = _played_repertoire(client)
    before = client.get("/api/dashboard").json()["training_sessions"]
    assert before == 1
    _delete(client, rep)
    assert client.get("/api/dashboard").json()["training_sessions"] == before


def test_deleting_repertoire_keeps_weekly_reviews(client):
    _register(client, "reviews@example.com")
    rep = _played_repertoire(client)
    before = client.get("/api/dashboard").json()["recap"]["moves_reviewed_7d"]
    assert before == 1
    _delete(client, rep)
    assert client.get("/api/dashboard").json()["recap"]["moves_reviewed_7d"] == before


def test_deleting_unplayed_repertoire_adds_nothing(client):
    _register(client, "two@example.com")
    rep = _played_repertoire(client)
    _delete(client, rep)
    rep2 = client.post(
        "/api/repertoires/create", json={"name": "Queen's Pawn", "color": "white"},
        headers=csrf_headers(client),
    ).json()["repertoire_id"]
    _delete(client, rep2)
    assert client.get("/api/dashboard").json()["training_sessions"] == 1
