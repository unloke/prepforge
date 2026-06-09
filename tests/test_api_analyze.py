"""Phase 2b-2d-i: ported analyze endpoints (browser-compute flow).

The Analyze view computes evals in the browser; these endpoints only orchestrate
(``prepare``), persist replayed evals (``classify-save``), and read history back
(``/api/analyses``). ``/api/board`` is a pure FEN utility. Same strangler wiring as
the workspace tests: FastAPI user -> ``current_owner`` bridge -> SQLAlchemy repo.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers

_PGN = """[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
"""


def _register(client: TestClient, email: str, *, display_name: str | None = None) -> str:
    r = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1", "display_name": display_name},
        headers=csrf_headers(client),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _client() -> TestClient:
    from prepforge_chess.api import main

    return TestClient(main.app)


def _prepare(client: TestClient, pgn: str = _PGN) -> dict:
    r = client.post("/api/analyze/prepare", json={"pgn": pgn}, headers=csrf_headers(client))
    assert r.status_code == 200, r.text
    return r.json()


def _classify_save(client: TestClient, prepared: dict, **overrides) -> "object":
    """Submit one trivial eval per prepared position (a slight White edge), so the
    ReplayEngine has a complete payload to classify."""
    positions = [{"fen": f, "score_cp": 20} for f in prepared["positions"]]
    body = {"game_id": prepared["game_id"], "positions": positions}
    body.update(overrides)
    return client.post("/api/analyze/classify-save", json=body, headers=csrf_headers(client))


# ---- prepare: gating + happy path ------------------------------------------


def test_prepare_requires_csrf(client):
    _register(client, "a@example.com")
    r = client.post("/api/analyze/prepare", json={"pgn": _PGN})
    assert r.status_code == 403


def test_prepare_requires_auth(client):
    r = client.post("/api/analyze/prepare", json={"pgn": _PGN}, headers=csrf_headers(client))
    assert r.status_code == 401


def test_prepare_returns_positions_and_move_skeleton(client):
    _register(client, "a@example.com")
    body = _prepare(client)
    assert body["engine"] == "stockfish (browser)"
    assert isinstance(body["depth"], int)
    assert body["game_id"]
    # 4 plies => 4 fen_before + the final fen_after = 5 distinct positions.
    assert len(body["positions"]) == 5
    assert [m["san"] for m in body["moves"]] == ["e4", "e5", "Nf3", "Nc6"]
    assert body["brilliant"]["rating"] >= 1


def test_prepare_rejects_empty_pgn(client):
    _register(client, "a@example.com")
    r = client.post("/api/analyze/prepare", json={"pgn": "   "}, headers=csrf_headers(client))
    assert r.status_code == 400


# ---- classify-save: persist + read back ------------------------------------


def test_classify_save_persists_and_is_recallable(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)

    r = _classify_save(client, prepared)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["game_id"] == prepared["game_id"]
    assert [m["san"] for m in payload["moves"]] == ["e4", "e5", "Nf3", "Nc6"]
    assert "summary" in payload and "eval_graph" in payload

    # History list shows the one analyzed game.
    analyses = client.get("/api/analyses").json()["analyses"]
    assert [a["game_id"] for a in analyses] == [prepared["game_id"]]

    # Recall round-trips through the latest-analysis read.
    recall = client.get(f"/api/analyses/{prepared['game_id']}")
    assert recall.status_code == 200
    assert recall.json()["game_id"] == prepared["game_id"]


def test_classify_save_rejects_missing_game_id(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/analyze/classify-save",
        json={"positions": [{"fen": "x"}]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_classify_save_rejects_empty_positions(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    r = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": []},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_classify_save_incomplete_payload_is_400(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    # Drop the positions the classifier needs for the last move -> ReplayEngineError -> 400.
    positions = [{"fen": f, "score_cp": 20} for f in prepared["positions"][:-2]]
    r = client.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": positions},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_classify_save_rejects_bad_maia_assessment(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    r = _classify_save(
        client,
        prepared,
        maia_assessments=[{"fen": "f", "uci": "e2e4", "human_probability": 2.0,
                           "win_chance_after": 0.5}],
    )
    assert r.status_code == 400


# ---- owner isolation -------------------------------------------------------


def test_classify_save_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    prepared = _prepare(client)  # A's game

    other = _client()
    _register(other, "b@example.com", display_name="B")
    positions = [{"fen": f, "score_cp": 20} for f in prepared["positions"]]
    r = other.post(
        "/api/analyze/classify-save",
        json={"game_id": prepared["game_id"], "positions": positions},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


def test_analyses_isolated_between_users(client):
    _register(client, "a@example.com", display_name="A")
    prepared = _prepare(client)
    assert _classify_save(client, prepared).status_code == 200

    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert other.get("/api/analyses").json() == {"analyses": []}
    # B cannot recall A's analysis.
    assert other.get(f"/api/analyses/{prepared['game_id']}").status_code == 404


def test_recall_unknown_game_is_404(client):
    _register(client, "a@example.com")
    assert client.get("/api/analyses/does-not-exist").status_code == 404


# ---- board utility ---------------------------------------------------------

_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def test_board_requires_auth(client):
    assert client.get(f"/api/board?fen={_START_FEN}").status_code == 401


def test_board_returns_legal_moves(client):
    _register(client, "a@example.com")
    r = client.get("/api/board", params={"fen": _START_FEN})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["side_to_move"] == "white"
    assert "e2e4" in body["legal_moves"]
    assert body["status"]["is_check"] is False


def test_board_rejects_bad_fen(client):
    _register(client, "a@example.com")
    r = client.get("/api/board", params={"fen": "not-a-fen"})
    assert r.status_code == 400
