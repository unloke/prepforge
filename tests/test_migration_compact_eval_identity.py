"""Forward migration d5a7e9f1b3c6: the evaluation digest is the whole key, as bytes.

Builds a database at the previous revision with real evaluation rows and a
child move referencing one, upgrades to head, and checks the digest converted
from hex to its 32 raw bytes without changing what dedupes, that the redundant
five-column unique key is gone, and that references survive the rebuild.
"""
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api import config as app_config
from prepforge_chess.storage import codec

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS = "c4f6d8e0a2b5"
FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


@pytest.fixture()
def migrate(tmp_path, monkeypatch):
    db_file = tmp_path / "eval_key.sqlite3"
    url = f"sqlite:///{db_file.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_TOKEN_KEY", "test-token-key-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    app_config.get_settings.cache_clear()
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    command.upgrade(cfg, PREVIOUS)
    engine = sa.create_engine(url)
    yield engine, cfg
    engine.dispose()
    app_config.get_settings.cache_clear()


def _digest(score_cp: int) -> str:
    return codec.evaluation_fingerprint(
        engine="stockfish (browser)", position_fen=FEN, depth=12, nodes=-1, time_ms=-1,
        score_cp=score_cp, mate_in=None, best_move_uci="e2e4", pv="e2e4 e7e5",
        wdl_win=None, wdl_draw=None, wdl_loss=None,
    )


def test_upgrade_stores_the_digest_as_bytes_and_keys_on_it(migrate):
    engine, cfg = migrate
    stamp = "'2026-01-01'"
    with engine.begin() as conn:
        conn.execute(sa.text(
            f"INSERT INTO users (id, email, plan, created_at, updated_at) "
            f"VALUES ('u1', 'u1@x.test', 'free', {stamp}, {stamp})"
        ))
        conn.execute(sa.text("INSERT INTO positions (id, fen) VALUES (1, :fen)"), {"fen": FEN})
        for row_id, score in ((1, 25), (2, -40)):
            conn.execute(sa.text(
                "INSERT INTO engine_evaluations (id, position_id, engine, depth, nodes, time_ms,"
                " score_cp, best_move_uci, pv, fingerprint)"
                " VALUES (:id, 1, 'stockfish (browser)', 12, -1, -1, :score, 'e2e4', 'e2e4 e7e5', :fp)"
            ), {"id": row_id, "score": score, "fp": _digest(score)})
        conn.execute(sa.text(
            "INSERT INTO games (id, source, initial_fen, result, uci_blob, tags_json, owner_user_id,"
            f" created_at, updated_at) VALUES ('g1', 'lichess', 'fen', '*', 'e2e4', '{{}}', 'u1', {stamp}, {stamp})"
        ))
        conn.execute(sa.text(
            "INSERT INTO moves (game_id, ply, uci, engine_eval_after_id, classification, source)"
            " VALUES ('g1', 1, 'e2e4', 2, 'best', 'lichess')"
        ))

    command.upgrade(cfg, "head")

    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "SELECT id, score_cp, fingerprint FROM engine_evaluations ORDER BY id"
        )).all()
        linked = conn.execute(sa.text("SELECT engine_eval_after_id FROM moves")).scalar_one()
        uniques = [
            list(u.get("column_names") or [])
            for u in sa.inspect(conn).get_unique_constraints("engine_evaluations")
        ]
        indexes = [
            (i["name"], i["column_names"], i["unique"])
            for i in sa.inspect(conn).get_indexes("engine_evaluations")
        ]
    assert linked == 2
    assert uniques == []
    assert indexes == [("uq_engine_evaluations_fingerprint", ["fingerprint"], True)]
    for row_id, score, stored in rows:
        assert isinstance(stored, bytes) and len(stored) == 32, (row_id, type(stored))
        assert stored == codec.fingerprint_bytes(_digest(score))

    # Same digest still dedupes; a different result is still its own row.
    with engine.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO engine_evaluations (position_id, engine, depth, nodes, time_ms,"
            " score_cp, best_move_uci, pv, fingerprint)"
            " VALUES (1, 'stockfish (browser)', 12, -1, -1, -40, 'e2e4', 'e2e4 e7e5', :fp)"
            " ON CONFLICT DO NOTHING"
        ), {"fp": codec.fingerprint_bytes(_digest(-40))})
        conn.execute(sa.text(
            "INSERT INTO engine_evaluations (position_id, engine, depth, nodes, time_ms,"
            " score_cp, best_move_uci, pv, fingerprint)"
            " VALUES (1, 'stockfish (browser)', 12, -1, -1, 900, 'e2e4', 'e2e4 e7e5', :fp)"
        ), {"fp": codec.fingerprint_bytes(_digest(900))})
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT COUNT(*) FROM engine_evaluations")).scalar_one() == 3
