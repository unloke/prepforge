import json
import os
import uuid
from datetime import datetime, timezone

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api.config import get_settings
from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import AnalysisResult, EngineEvaluation
from prepforge_chess.storage import codec
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


@pytest.fixture(params=["sqlite", "postgres"])
def migrated(request, tmp_path, monkeypatch):
    admin = None
    schema = None
    if request.param == "postgres":
        raw = os.getenv("TEST_POSTGRES_URL")
        if not raw:
            pytest.skip("TEST_POSTGRES_URL requires real PostgreSQL")
        url = raw.replace("postgresql://", "postgresql+psycopg://", 1)
        schema = "snapshots_" + uuid.uuid4().hex[:16]
        admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        monkeypatch.setenv("PGOPTIONS", "-c search_path=" + schema)
    else:
        url = "sqlite:///" + str(tmp_path / "snapshots.sqlite3")
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    engine = sa.create_engine(url)
    try:
        command.upgrade(cfg, "head")
        yield cfg, engine
    finally:
        engine.dispose()
        get_settings.cache_clear()
        if admin:
            with admin.connect() as conn:
                conn.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')


def test_existing_snapshots_survive_the_binary_column_migration(migrated):
    cfg, engine = migrated
    repo = WorkspaceRepository(engine)
    game = ChessCore().import_single_pgn('[Result "*"]\n\n1. e4 e5 2. Nf3 *')
    repo.save_game(game, AnalysisResult(game.id, datetime.now(timezone.utc), "engine", 12, game.moves, {"best": 1}))

    command.downgrade(cfg, "8e4a6c2d0f91")
    with engine.connect() as conn:
        stored = conn.exec_driver_sql("SELECT move_results_json FROM analysis_results").scalar_one()
    assert json.loads(stored)["codec"] == "analysis-zlib-base64-v2"

    command.upgrade(cfg, "head")
    loaded = repo.load_latest_analysis_result(game.id)
    assert [move.uci for move in loaded.move_results] == ["e2e4", "e7e5", "g1f3"]
    assert "move_snapshot_missing" not in (loaded.quality or {})


def test_existing_positions_and_pvs_survive_the_packing_migration(migrated):
    cfg, engine = migrated
    repo = WorkspaceRepository(engine)
    game = ChessCore().import_single_pgn('[Result "*"]\n\n1. e4 e5 2. Nf3 *')
    for move in game.moves:
        move.engine_eval_after = EngineEvaluation(engine="sf", depth=12, score_cp=30, pv=["e7e5", "g1f3", "b8c6"])
    repo.save_game(game)

    command.downgrade(cfg, "a1c3e5f7b9d2")
    with engine.connect() as conn:
        fens = set(conn.exec_driver_sql("SELECT fen FROM positions").scalars())
        pvs = set(conn.exec_driver_sql("SELECT pv FROM engine_evaluations").scalars())
    assert fens == {move.fen_after for move in game.moves}
    assert pvs == {"e7e5 g1f3 b8c6"}

    command.upgrade(cfg, "head")
    loaded = repo.load_game(game.id)
    assert [move.engine_eval_after.pv for move in loaded.moves] == [["e7e5", "g1f3", "b8c6"]] * 3
    repo.save_game(game)
    with engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT count(*) FROM positions").scalar_one() == 3
        assert conn.exec_driver_sql("SELECT count(*) FROM engine_evaluations").scalar_one() == 3


def test_pv_packing_refreshes_fingerprints_and_remaps_duplicates(migrated):
    cfg, engine = migrated
    repo = WorkspaceRepository(engine)
    pgn = '[FEN "7k/P7/8/8/8/8/8/K7 w - - 0 1"]\n[Result "*"]\n\n1. a8=Q+ *'
    game = ChessCore().import_single_pgn(pgn)
    move = game.moves[0]
    move.engine_eval_before = EngineEvaluation(engine="sf", depth=12, score_cp=900, pv=["a7a8q"])
    move.best_move_eval = EngineEvaluation(engine="sf", depth=12, score_cp=875, pv=["a7a8q"])
    repo.save_game(game)

    command.downgrade(cfg, "a1c3e5f7b9d2")
    with engine.begin() as conn:
        evaluations = sa.Table("engine_evaluations", sa.MetaData(), autoload_with=conn)
        rows = conn.execute(sa.select(evaluations)).mappings().all()
        for row in rows:
            upper = "a7a8Q"
            fields = {name: row[name] for name in (
                "engine", "depth", "nodes", "time_ms", "score_cp", "mate_in",
                "best_move_uci", "wdl_win", "wdl_draw", "wdl_loss",
            )}
            fingerprint = codec.fingerprint_bytes(codec.evaluation_fingerprint(
                position_fen=move.fen_before, pv=upper, **fields,
            ))
            if row["score_cp"] == 900:
                data = {key: value for key, value in row.items() if key != "id"}
                duplicate = conn.scalar(evaluations.insert().values(
                    {**data, "pv": upper, "fingerprint": fingerprint},
                ).returning(evaluations.c.id))
                conn.execute(sa.text("UPDATE moves SET engine_eval_before_id = :id"), {"id": duplicate})
            else:
                conn.execute(evaluations.update().where(evaluations.c.id == row["id"]).values(
                    pv=upper, fingerprint=fingerprint,
                ))

    command.upgrade(cfg, "head")
    loaded = repo.load_game(game.id)
    assert loaded.moves[0].engine_eval_before.pv == ["a7a8q"]
    assert loaded.moves[0].best_move_eval.pv == ["a7a8q"]
    repo.save_game(loaded)
    with engine.connect() as conn:
        assert conn.execute(sa.text(
            "SELECT score_cp FROM engine_evaluations ORDER BY score_cp",
        )).scalars().all() == [875, 900]


def test_large_position_and_pv_packing_batches_driver_calls(tmp_path, monkeypatch):
    """The production migration must not need one network round trip per row."""
    db_url = f"sqlite:///{(tmp_path / 'packing.sqlite3').as_posix()}"
    engine = sa.create_engine(db_url)
    monkeypatch.setenv("DATABASE_URL", db_url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "a1c3e5f7b9d2")

    count = 1201
    positions = []
    evaluations = []
    for row_id in range(1, count + 1):
        fen = f"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 {row_id}"
        pv = "e2e4 e7e5"
        fingerprint = codec.fingerprint_bytes(codec.evaluation_fingerprint(
            position_fen=fen,
            engine="stockfish",
            depth=12,
            nodes=-1,
            time_ms=-1,
            score_cp=25,
            mate_in=None,
            best_move_uci="e2e4",
            pv=pv,
            wdl_win=None,
            wdl_draw=None,
            wdl_loss=None,
        ))
        positions.append({"id": row_id, "fen": fen})
        evaluations.append({
            "id": row_id,
            "position_id": row_id,
            "fingerprint": fingerprint,
        })
    with engine.begin() as conn:
        conn.execute(sa.text("INSERT INTO positions (id, fen) VALUES (:id, :fen)"), positions)
        conn.execute(sa.text(
            "INSERT INTO engine_evaluations"
            " (id, position_id, engine, depth, nodes, time_ms, score_cp, best_move_uci, pv, fingerprint)"
            " VALUES (:id, :position_id, 'stockfish', 12, -1, -1, 25, 'e2e4', 'e2e4 e7e5', :fingerprint)"
        ), evaluations)

    calls = {"positions": [], "engine_evaluations": []}

    def collect(conn, cursor, statement, parameters, context, executemany):
        for table in calls:
            if statement.startswith(f"UPDATE {table} SET"):
                size = len(parameters) if executemany else 1
                calls[table].append((executemany, size))

    sa.event.listen(sa.engine.Engine, "before_cursor_execute", collect)
    try:
        command.upgrade(cfg, "head")
    finally:
        sa.event.remove(sa.engine.Engine, "before_cursor_execute", collect)
        get_settings.cache_clear()

    expected_batches = (count + 499) // 500
    for table in calls:
        assert len(calls[table]) <= expected_batches
        assert sum(size for _many, size in calls[table]) == count
    with engine.connect() as conn:
        assert conn.scalar(sa.text("SELECT COUNT(*) FROM positions WHERE key IS NOT NULL")) == count
        assert conn.scalar(sa.text("SELECT COUNT(*) FROM engine_evaluations WHERE length(pv) = 4")) == count
