"""f3a9c1e7b2d4 must make engine_evaluations rows immutable snapshots on every dialect.

The migration adds ``fingerprint`` (a digest of the full snapshot identity +
result, ``codec.evaluation_fingerprint``) to the dedupe key so a later
submission can never rewrite a row an earlier analysis references (improvement
review D-01). What can silently break:

1. the backfill digest not matching what the writer computes (a stored row
   would then never dedupe against its own re-submission), and
2. dialect-specific schema semantics: the old 5-tuple UNIQUE must be replaced
   by the 6-tuple one — SQLite needs a batch rebuild (its unnamed UNIQUE cannot
   be dropped in place), PostgreSQL plain DDL.

Both are exercised here against a real upgrade from b7d21c93e4a8 (the last
revision before the change) with pre-existing rows: PostgreSQL when
TEST_POSTGRES_URL is set (the CI ``postgres`` job provides it), plus a SQLite
path for local runs.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.storage import codec


def _pg_url(raw: str) -> str:
    # Mirror test_migration_lichess_primary: pin bare postgres:// URLs to
    # psycopg v3 like the app does, or SQLAlchemy defaults to psycopg2.
    if raw.startswith("postgresql://"):
        return "postgresql+psycopg://" + raw[len("postgresql://") :]
    if raw.startswith("postgres://"):
        return "postgresql+psycopg://" + raw[len("postgres://") :]
    return raw


def _alembic_config(db_url: str, monkeypatch, connect_options: str | None = None) -> Config:
    monkeypatch.setenv("DATABASE_URL", db_url)
    if connect_options:
        monkeypatch.setenv("PGOPTIONS", connect_options)
    from prepforge_chess.api import config as app_config

    app_config.get_settings.cache_clear()
    return Config("alembic.ini")


def _chain_head(cfg: Config) -> str:
    """Current head of the migration chain — later migrations extend the chain
    and must not break this contract test just by existing."""
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(cfg).get_current_head()


def _seed_pre_migration_rows(engine: sa.Engine) -> dict:
    """Old-shape rows at b7d21c93e4a8 (5-tuple unique, no fingerprint)."""
    fen1 = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    fen2 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    rows = [
        # (id, fen, engine, depth, nodes, time_ms, score_cp, mate_in, best, pv, wdl)
        (1, fen1, "stockfish (browser)", 16, -1, -1, 25, None, "e2e4", "e2e4 e7e5", (None, None, None)),
        (2, fen1, "stockfish (browser)", 8, -1, -1, -10, None, None, "", (1, 2, 3)),
        (3, fen2, "stockfish", 20, 5000, 80, None, -2, "d2d4", "d2d4", (None, None, None)),
    ]
    with engine.begin() as conn:
        conn.execute(
            sa.text("INSERT INTO positions (id, fen) VALUES (:id, :fen)"),
            {"id": 1, "fen": fen1},
        )
        conn.execute(
            sa.text("INSERT INTO positions (id, fen) VALUES (:id, :fen)"),
            {"id": 2, "fen": fen2},
        )
        for row_id, fen, engine_name, depth, nodes, time_ms, score, mate, best, pv, wdl in rows:
            conn.execute(
                sa.text(
                    "INSERT INTO engine_evaluations"
                    " (id, position_id, engine, depth, nodes, time_ms, score_cp, mate_in,"
                    " best_move_uci, pv, wdl_win, wdl_draw, wdl_loss)"
                    " VALUES (:id, :pid, :engine, :depth, :nodes, :time_ms, :score, :mate,"
                    " :best, :pv, :w0, :w1, :w2)"
                ),
                {
                    "id": row_id,
                    "pid": 1 if fen == fen1 else 2,
                    "engine": engine_name,
                    "depth": depth,
                    "nodes": nodes,
                    "time_ms": time_ms,
                    "score": score,
                    "mate": mate,
                    "best": best,
                    "pv": pv,
                    "w0": wdl[0],
                    "w1": wdl[1],
                    "w2": wdl[2],
                },
            )
    return {"fen1": fen1, "fen2": fen2, "rows": rows}


def _check_upgraded(engine: sa.Engine, seed: dict) -> None:
    insp = sa.inspect(engine)
    uniques = insp.get_unique_constraints("engine_evaluations")
    assert any(
        list(u.get("column_names") or [])
        == ["position_id", "engine", "depth", "nodes", "time_ms", "fingerprint"]
        for u in uniques
    ), uniques
    assert not any(
        list(u.get("column_names") or [])
        == ["position_id", "engine", "depth", "nodes", "time_ms"]
        for u in uniques
    ), uniques
    columns = {c["name"]: c for c in insp.get_columns("engine_evaluations")}
    assert columns["fingerprint"]["nullable"] is False

    with engine.connect() as conn:
        stored = conn.execute(
            sa.text(
                "SELECT id, engine, position_id, depth, nodes, time_ms, score_cp,"
                " mate_in, best_move_uci, pv, wdl_win, wdl_draw, wdl_loss, fingerprint"
                " FROM engine_evaluations ORDER BY id"
            )
        ).mappings().all()
        fens = {
            int(row["id"]): row["fen"]
            for row in conn.execute(sa.text("SELECT id, fen FROM positions")).mappings()
        }
    assert len(stored) == 3

    # 1. The backfill must be bit-for-bit what the writer computes.
    for row in stored:
        expected = codec.evaluation_fingerprint(
            engine=row["engine"],
            position_fen=fens[row["position_id"]],
            depth=row["depth"],
            nodes=row["nodes"],
            time_ms=row["time_ms"],
            score_cp=row["score_cp"],
            mate_in=row["mate_in"],
            best_move_uci=row["best_move_uci"],
            pv=row["pv"],
            wdl_win=row["wdl_win"],
            wdl_draw=row["wdl_draw"],
            wdl_loss=row["wdl_loss"],
        )
        assert row["fingerprint"] == expected, row["id"]

    # 2. New semantics: different content under the same search identity now
    #    coexists (immutable snapshots); an identical re-insert is a dedupe hit
    #    at the SQL level only (the repository resolves the existing id).
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO engine_evaluations"
                " (id, position_id, engine, depth, nodes, time_ms, score_cp, mate_in,"
                " best_move_uci, pv, wdl_win, wdl_draw, wdl_loss, fingerprint)"
                " VALUES (:id, 1, 'stockfish (browser)', 16, -1, -1, -900, NULL,"
                " 'd2d4', 'd2d4', NULL, NULL, NULL, :fp)"
            ),
            {
                "id": 101,
                "fp": codec.evaluation_fingerprint(
                    engine="stockfish (browser)",
                    position_fen=seed["fen1"],
                    depth=16,
                    nodes=-1,
                    time_ms=-1,
                    score_cp=-900,
                    mate_in=None,
                    best_move_uci="d2d4",
                    pv="d2d4",
                    wdl_win=None,
                    wdl_draw=None,
                    wdl_loss=None,
                ),
            },
        )
    with pytest.raises(sa.exc.IntegrityError):
        with engine.begin() as conn:
            conn.execute(
                sa.text(
                    "INSERT INTO engine_evaluations"
                    " (id, position_id, engine, depth, nodes, time_ms, score_cp,"
                    " best_move_uci, pv, fingerprint)"
                    " VALUES (:id, 1, 'stockfish (browser)', 16, -1, -1, 25,"
                    " 'e2e4', 'e2e4 e7e5', :fp)"
                ),
                {"id": 102, "fp": stored[0]["fingerprint"]},
            )


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"),
    reason="PostgreSQL URL not provided (TEST_POSTGRES_URL); SQLite covers the path locally",
)
def test_fingerprint_identity_migration_postgres(monkeypatch) -> None:
    postgres_url = os.environ["TEST_POSTGRES_URL"]
    schema = f"mig_{uuid.uuid4().hex[:12]}"
    admin = sa.create_engine(_pg_url(postgres_url), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    try:
        base = _pg_url(postgres_url)
        engine = sa.create_engine(base, connect_args={"options": f"-csearch_path={schema}"})
        cfg = _alembic_config(base, monkeypatch, connect_options=f"-csearch_path={schema}")
        command.upgrade(cfg, "b7d21c93e4a8")
        seed = _seed_pre_migration_rows(engine)
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
        # Compare against the actual chain head — later migrations must not
        # break this migration contract test just by existing.
        assert version == _chain_head(cfg)
        _check_upgraded(engine, seed)
    finally:
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))


def test_fingerprint_identity_migration_sqlite(tmp_path, monkeypatch) -> None:
    db_url = f"sqlite:///{(tmp_path / 'mig.sqlite3').as_posix()}"
    engine = sa.create_engine(db_url)
    cfg = _alembic_config(db_url, monkeypatch)
    command.upgrade(cfg, "b7d21c93e4a8")
    seed = _seed_pre_migration_rows(engine)
    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        version = conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    assert version == _chain_head(cfg)
    _check_upgraded(engine, seed)
