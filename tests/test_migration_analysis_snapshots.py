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
