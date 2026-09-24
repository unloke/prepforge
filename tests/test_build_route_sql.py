"""SQL counts across auth, ownership, mutation, and Build response serialization."""
from __future__ import annotations

import os
import uuid

import chess
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from api_helpers import csrf_headers
from prepforge_chess.api import config, db, main
from prepforge_chess.api.ratelimit import limiter
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import MoveSource, OpeningNode
from prepforge_chess.storage.repositories import PrepForgeRepository


def _measured(engine, request):
    statements = []

    def collect(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", collect)
    try:
        response = request()
    finally:
        event.remove(engine, "before_cursor_execute", collect)
    assert response.status_code == 200, response.text
    tree_reads = sum(
        statement.lstrip().upper().startswith("SELECT") and "opening_nodes" in statement
        for statement in statements
    )
    return len(statements), tree_reads, response.json()


def _seed_tree(engine, repertoire_id, size=100):
    repo = PrepForgeRepository(engine)
    repertoire = repo.load_repertoire(repertoire_id)
    core = ChessCore()
    queue = [repertoire.root_node]
    count = 1
    while queue and count < size:
        parent = queue.pop(0)
        for move in list(chess.Board(parent.fen).legal_moves)[:4]:
            if count >= size:
                break
            record = core.apply_uci(parent.fen, move.uci(), source=MoveSource.MANUAL)
            child = OpeningNode(
                id=str(uuid.uuid4()), repertoire_id=repertoire_id, parent_id=parent.id,
                move=record, fen=record.fen_after,
                side_to_move=core.side_to_move(record.fen_after), source=MoveSource.MANUAL,
            )
            parent.children.append(child)
            queue.append(child)
            count += 1
    repo.save_repertoire(repertoire)


def _exercise_routes(client):
    email = f"sql-route-{uuid.uuid4()}@example.com"
    registered = client.post(
        "/api/auth/register",
        json={"email": email, "password": "longpassword1"},
        headers=csrf_headers(client),
    )
    assert registered.status_code == 201, registered.text
    created = client.post(
        "/api/repertoires/create",
        json={"name": "Route SQL", "color": "white"},
        headers=csrf_headers(client),
    )
    assert created.status_code == 200, created.text
    rep_id = created.json()["repertoire_id"]
    node_id = created.json()["selected_node_id"]
    engine = db.get_engine()
    _seed_tree(engine, rep_id)
    load = _measured(engine, lambda: client.get(
        "/api/build/load", params={"repertoire_id": rep_id}
    ))
    prepared = _measured(engine, lambda: client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "mark_prepared"},
        headers=csrf_headers(client),
    ))
    annotations = _measured(engine, lambda: client.post(
        "/api/build/annotations",
        json={"repertoire_id": rep_id, "node_id": node_id,
              "arrows": ["Ge2e4"], "circles": ["Rd4"]},
        headers=csrf_headers(client),
    ))
    branch = _measured(engine, lambda: client.post(
        "/api/build/action",
        json={"repertoire_id": rep_id, "node_id": node_id, "action": "disable_branch"},
        headers=csrf_headers(client),
    ))
    for count, reads, _payload in [load, prepared, annotations, branch]:
        assert reads == 1, (count, reads)
    assert prepared[2]["nodes"][0]["is_prepared"]
    assert not branch[2]["nodes"][0]["is_enabled"]
    return {"load": load[0], "mark_prepared": prepared[0],
            "annotations": annotations[0], "disable_branch": branch[0]}


def test_build_route_sql_counts_sqlite(client):
    counts = _exercise_routes(client)
    if os.getenv("BUILD_SQL_BENCHMARK"):
        print(f"SQLite route SQL counts: {counts}")
    assert counts["load"] <= 12, counts
    assert counts["mark_prepared"] <= 10, counts
    assert counts["annotations"] <= 7, counts
    assert counts["disable_branch"] <= 10, counts


def test_build_route_sql_counts_postgres(monkeypatch):
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL is not configured")
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_TOKEN_KEY", "test-token-key-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    config.get_settings.cache_clear()
    db._engine = None
    db._SessionLocal = None
    limiter.enabled = False
    db.Base.metadata.create_all(db.make_engine())
    with TestClient(main.app) as client:
        counts = _exercise_routes(client)
    if os.getenv("BUILD_SQL_BENCHMARK"):
        print(f"PostgreSQL route SQL counts: {counts}")
    assert counts["load"] <= 12, counts
    assert counts["mark_prepared"] <= 10, counts
    assert counts["annotations"] <= 7, counts
    assert counts["disable_branch"] <= 10, counts
