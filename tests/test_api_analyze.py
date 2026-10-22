"""Phase 2b-2d-i: ported analyze endpoints (browser-compute flow).

The Analyze view computes evals in the browser; these endpoints only orchestrate
(``prepare``), persist replayed evals (``classify-save``), and read history back
(``/api/analyses``). Same strangler wiring as
the workspace tests: FastAPI user -> ``current_owner`` bridge -> SQLAlchemy repo.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from api_helpers import csrf_headers


def test_analyze_prepare_rejects_oversized_pgn(client):
    _register(client, "large-pgn@example.com")
    response = client.post(
        "/api/analyze/prepare",
        json={"pgn": "x" * 1_000_001},
        headers=csrf_headers(client),
    )
    assert response.status_code == 422


def test_analyze_classify_rejects_too_many_positions(client):
    _register(client, "many-positions@example.com")
    response = client.post(
        "/api/analyze/classify-save",
        json={"game_id": "unused", "positions": [{}] * 1_001},
        headers=csrf_headers(client),
    )
    assert response.status_code == 422

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
    browser classifier has a complete payload."""
    positions = [{"depth": 10, "fen": f, "score_cp": 20} for f in prepared["positions"]]
    body = {"engine": "sf-test", "game_id": prepared["game_id"], "positions": positions}
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
    assert "engine" not in body
    assert isinstance(body["depth"], int)
    assert body["game_id"]
    # 4 plies => 4 fen_before + the final fen_after = 5 distinct positions.
    assert len(body["positions"]) == 5
    assert [m["san"] for m in body["moves"]] == ["e4", "e5", "Nf3", "Nc6"]
    # The analyzed game's own PGN: the client re-parses exactly this text.
    assert body["pgn"].strip().endswith("1. e4 e5 2. Nf3 Nc6 *")
    assert '[White "Alice"]' in body["pgn"]
    # rating echoes the owner's pinned Maia3 strength; a fresh user is unset → AUTO
    # (None), resolved client-side. When pinned it is a positive int.
    assert body["brilliant"]["enabled"] is True
    rating = body["brilliant"]["rating"]
    assert rating is None or rating >= 1


def test_prepare_rejects_empty_pgn(client):
    _register(client, "a@example.com")
    r = client.post("/api/analyze/prepare", json={"pgn": "   "}, headers=csrf_headers(client))
    assert r.status_code == 400


# ---- classify-save: persist + read back ------------------------------------


def test_recall_of_a_snapshot_in_an_older_codec_asks_for_a_new_analysis(client):
    from sqlalchemy import update

    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables

    _register(client, "old@example.com")
    prepared = _prepare(client)
    assert _classify_save(client, prepared).status_code == 200
    with db.get_engine().begin() as conn:
        conn.execute(update(sa_tables.analysis_results).values(
            move_results_json='{"codec":"zlib-base64-v1","data":"eJyLjgUAARUAuQ=="}'))
    recall = client.get(f"/api/analyses/{prepared['game_id']}")
    assert recall.status_code == 409
    assert "Analyze this game again" in recall.json()["detail"]


def test_classify_save_persists_and_is_recallable(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)

    r = _classify_save(client, prepared)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["game_id"] == prepared["game_id"]
    assert len(payload["eval_graph"]) == len(payload["moves"]) == 4
    assert [m["san"] for m in payload["moves"]] == ["e4", "e5", "Nf3", "Nc6"]
    assert "summary" in payload and "eval_graph" in payload
    assert set(payload["position_evals"]) == set(prepared["positions"])
    assert payload["position_evals"][prepared["positions"][0]]["score_cp"] == 20

    # History list shows the one analyzed game.
    analyses = client.get("/api/analyses").json()["analyses"]
    assert [a["game_id"] for a in analyses] == [prepared["game_id"]]

    # Recall round-trips through the latest-analysis read.
    recall = client.get(f"/api/analyses/{prepared['game_id']}")
    assert recall.status_code == 200
    assert recall.json()["game_id"] == prepared["game_id"]
    assert recall.json()["eval_graph"] == payload["eval_graph"]
    assert set(recall.json()["position_evals"]) == set(prepared["positions"])


def test_analysis_lookup_by_lichess_id_filters_before_paging_and_is_owner_scoped(client):
    _register(client, "saved-game@example.com")
    pgn = _PGN.replace('[Event "Test"]', '[Event "Test"]\n[Site "https://lichess.org/A1b2C3d4"]')
    prepared = _prepare(client, pgn)
    assert _classify_save(client, prepared).status_code == 200
    unrelated = _prepare(client, pgn.replace("A1b2C3d4", "E5f6G7h8"))
    assert _classify_save(client, unrelated).status_code == 200

    query = "/api/analyses?lichess_id=A1b2C3d4&limit=1"
    result = client.get(query).json()
    assert [row["game_id"] for row in result["analyses"]] == [prepared["game_id"]]
    assert result["next_cursor"] is None
    assert client.get("/api/analyses?lichess_id=unknown").json()["analyses"] == []

    with _client() as other:
        _register(other, "other-saved-game@example.com")
        assert other.get(query).json()["analyses"] == []
        other_game = _prepare(other, pgn)
        assert _classify_save(other, other_game).status_code == 200
        assert [row["game_id"] for row in other.get(query).json()["analyses"]] == [other_game["game_id"]]
    assert [row["game_id"] for row in client.get(query).json()["analyses"]] == [prepared["game_id"]]


def test_classify_save_rejects_missing_game_id(client):
    _register(client, "a@example.com")
    r = client.post(
        "/api/analyze/classify-save",
        json={"engine": "sf-test", "positions": [{"fen": "x"}]},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


# ---- delete: saved analyses can be removed ---------------------------------


def test_delete_analysis_removes_it_from_history_and_recall(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    assert _classify_save(client, prepared).status_code == 200

    r = client.delete(
        f"/api/analyses/{prepared['game_id']}", headers=csrf_headers(client)
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    # Gone from the history list...
    assert client.get("/api/analyses").json()["analyses"] == []
    # ...and from recall, which now 404s.
    assert client.get(f"/api/analyses/{prepared['game_id']}").status_code == 404
    # Deleting again is a 404, not a silent success on nothing.
    assert (
        client.delete(
            f"/api/analyses/{prepared['game_id']}", headers=csrf_headers(client)
        ).status_code
        == 404
    )


def test_delete_analysis_requires_csrf(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    _classify_save(client, prepared)
    r = client.delete(f"/api/analyses/{prepared['game_id']}")
    assert r.status_code == 403
    # The analysis survived the rejected delete.
    assert client.get(f"/api/analyses/{prepared['game_id']}").status_code == 200


def test_delete_analysis_is_owner_scoped(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    _classify_save(client, prepared)
    _register(client, "b@example.com")
    # Another owner cannot delete it, and cannot tell it exists.
    r = client.delete(
        f"/api/analyses/{prepared['game_id']}", headers=csrf_headers(client)
    )
    assert r.status_code == 404
    assert client.get("/api/analyses").json()["analyses"] == []


def test_delete_analysis_keeps_the_game_row(client):
    """The PGN is the user's; only the server-side analysis is removed. A later
    analyze of the same PGN re-imports onto the same game rather than forking
    a new row."""
    _register(client, "a@example.com")
    prepared = _prepare(client)
    _classify_save(client, prepared)
    client.delete(f"/api/analyses/{prepared['game_id']}", headers=csrf_headers(client))
    again = _prepare(client)
    assert again["game_id"] == prepared["game_id"]


def test_classify_save_rejects_empty_positions(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    r = client.post(
        "/api/analyze/classify-save",
        json={"engine": "sf-test", "game_id": prepared["game_id"], "positions": []},
        headers=csrf_headers(client),
    )
    assert r.status_code == 400


def test_classify_save_incomplete_payload_is_400(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    # Drop the positions the classifier needs for the last move -> ReplayEngineError -> 400.
    positions = [{"depth": 10, "fen": f, "score_cp": 20} for f in prepared["positions"][:-2]]
    r = client.post(
        "/api/analyze/classify-save",
        json={"engine": "sf-test", "game_id": prepared["game_id"], "positions": positions},
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


def test_classify_save_rejects_out_of_range_trap_gap(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    # trap_gap is a difference of win chances, so it must stay in [-1, 1]; 2.0 is rejected.
    r = _classify_save(
        client,
        prepared,
        maia_assessments=[{"fen": "f", "uci": "e2e4", "human_probability": 0.05,
                           "win_chance_after": 0.5, "trap_gap": 2.0}],
    )
    assert r.status_code == 400


def test_classify_save_accepts_optional_trap_gap(client):
    _register(client, "a@example.com")
    prepared = _prepare(client)
    # A well-formed assessment WITH a trap_gap is accepted (the browser-supplied trap
    # layer); the move just isn't brilliant on this trivial flat-eval game.
    r = _classify_save(
        client,
        prepared,
        maia_assessments=[{"fen": prepared["positions"][0], "uci": "e2e4",
                           "human_probability": 0.05, "win_chance_after": 0.5,
                           "trap_gap": 0.2}],
    )
    assert r.status_code == 200, r.text


# ---- owner isolation -------------------------------------------------------


def test_classify_save_is_owner_gated(client):
    _register(client, "a@example.com", display_name="A")
    prepared = _prepare(client)  # A's game

    other = _client()
    _register(other, "b@example.com", display_name="B")
    positions = [{"depth": 10, "fen": f, "score_cp": 20} for f in prepared["positions"]]
    r = other.post(
        "/api/analyze/classify-save",
        json={"engine": "sf-test", "game_id": prepared["game_id"], "positions": positions},
        headers=csrf_headers(other),
    )
    assert r.status_code == 404


def test_analyses_isolated_between_users(client):
    _register(client, "a@example.com", display_name="A")
    prepared = _prepare(client)
    assert _classify_save(client, prepared).status_code == 200

    other = _client()
    _register(other, "b@example.com", display_name="B")
    assert other.get("/api/analyses").json() == {"analyses": [], "next_cursor": None}
    # B cannot recall A's analysis.
    assert other.get(f"/api/analyses/{prepared['game_id']}").status_code == 404


def test_recall_unknown_game_is_404(client):
    _register(client, "a@example.com")
    assert client.get("/api/analyses/does-not-exist").status_code == 404


def test_recall_legacy_snapshot_requests_reanalysis(client):
    from sqlalchemy import update
    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables as t

    _register(client, "legacy-report@example.com")
    prepared = _prepare(client)
    assert _classify_save(client, prepared).status_code == 200
    with db.get_engine().begin() as conn:
        conn.execute(update(t.analysis_results).where(
            t.analysis_results.c.game_id == prepared["game_id"]
        ).values(move_results_json=None))
    response = client.get(f"/api/analyses/{prepared['game_id']}")
    assert response.status_code == 409
    assert "Analyze this game again" in response.json()["detail"]
    assert _classify_save(client, prepared).status_code == 200
    assert client.get(f"/api/analyses/{prepared['game_id']}").status_code == 200


def test_classify_save_retry_reuses_the_same_snapshot(client):
    from uuid import uuid4
    from sqlalchemy import select, func
    from prepforge_chess.api import db
    from prepforge_chess.storage import sa_tables as t
    _register(client, "retry-save@example.com")
    prepared = _prepare(client)
    request_id = str(uuid4())
    first = _classify_save(client, prepared, request_id=request_id)
    second = _classify_save(client, prepared, request_id=request_id)
    assert first.status_code == second.status_code == 200
    assert first.json()["moves"] == second.json()["moves"]
    assert first.json()["summary"] == second.json()["summary"]
    with db.get_engine().connect() as conn:
        count = conn.execute(select(func.count()).select_from(t.analysis_results).where(t.analysis_results.c.game_id == prepared["game_id"])).scalar_one()
    assert count == 1
    assert _classify_save(client, prepared, request_id=str(uuid4())).status_code == 200
    with db.get_engine().connect() as conn:
        assert conn.execute(select(func.count()).select_from(t.analysis_results).where(t.analysis_results.c.game_id == prepared["game_id"])).scalar_one() == 2


def test_analysis_save_status_is_receipt_and_owner_scoped(client):
    from uuid import uuid4
    _register(client, "status@example.com")
    prepared = _prepare(client)
    request_id = str(uuid4())
    path = f"/api/analyses/{prepared['game_id']}/saves/{request_id}/status"
    assert client.get(path).json() == {"saved": False}
    assert _classify_save(client, prepared, request_id=request_id).status_code == 200
    assert client.get(path).json() == {"saved": True}
    client.post("/api/auth/logout")
    _register(client, "other-status@example.com")
    assert client.get(path).json() == {"saved": False}


def test_classify_requires_actual_depth_for_each_position(client):
    _register(client, "actual-depth@example.com")
    prepared = _prepare(client)
    positions = [{"fen": fen, "score_cp": 20} for fen in prepared["positions"]]
    response = _classify_save(client, prepared, depth=16, positions=positions)
    assert response.status_code == 400
    assert "depth is required" in response.json()["detail"]
