"""Drift guard: the SQLAlchemy legacy schema must match schema.sql.

Phase 2a-1 reproduced the raw-SQL legacy schema as SQLAlchemy Core tables
(``storage/sa_tables.py``); 2a-2 made those tables the live backend. ``schema.sql``
survives only as the historical static reference, so this test fails loudly if the
two drift apart — a column added to one but not the other. The legacy side is loaded
straight from ``schema.sql`` via a throwaway ``sqlite3`` connection (independent of
the production ``initialize_database`` path, which is now SQLAlchemy). ``schema.sql``
is retired with the Alembic baseline (Phase 2a-3).
"""
from __future__ import annotations

import sqlite3

from sqlalchemy import create_engine, inspect

from prepforge_chess.storage import sa_tables
from prepforge_chess.storage.database import SCHEMA_PATH

# The 19 tables sa_tables owns. The new SaaS identity tables (users, teams, ...)
# share the same MetaData but are NOT part of the legacy schema, so they are
# excluded from the comparison.
LEGACY_TABLES = {
    "user_profiles",
    "games",
    "positions",
    "engine_evaluations",
    "moves",
    "analysis_results",
    "maia_predictions",
    "repertoires",
    "opening_nodes",
    "opening_lines",
    "generation_runs",
    "training_sessions",
    "training_progress",
    "training_mistakes",
    "lichess_imports",
    "practical_opening_matches",
    "engine_settings",
    "app_settings",
    "user_sessions",
}


def _legacy_columns() -> dict[str, set[str]]:
    """Column sets from the raw static schema.sql (the historical reference)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        out: dict[str, set[str]] = {}
        for table in LEGACY_TABLES:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
            out[table] = {row["name"] for row in rows}
        return out
    finally:
        conn.close()


def _sqlalchemy_columns() -> dict[str, set[str]]:
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine)
    insp = inspect(engine)
    return {t: {c["name"] for c in insp.get_columns(t)} for t in LEGACY_TABLES}


def test_sa_schema_defines_every_legacy_table():
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine)
    created = set(inspect(engine).get_table_names())
    missing = LEGACY_TABLES - created
    assert not missing, f"sa_tables is missing legacy tables: {sorted(missing)}"


def test_sa_columns_match_schema_sql():
    legacy = _legacy_columns()
    sa = _sqlalchemy_columns()
    for table in sorted(LEGACY_TABLES):
        assert sa[table] == legacy[table], (
            f"{table}: sa-only={sorted(sa[table] - legacy[table])}, "
            f"schema.sql-only={sorted(legacy[table] - sa[table])}"
        )


def test_sa_games_round_trip():
    """The SA schema is usable, not just declared: insert + select a games row."""
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            sa_tables.games.insert(),
            {
                "id": "g1",
                "source": "manual",
                "initial_fen": "startpos",
                "result": "*",
                "tags_json": "{}",
                "owner_user_id": "u1",
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
            },
        )
    with engine.connect() as conn:
        row = conn.execute(
            sa_tables.games.select().where(sa_tables.games.c.id == "g1")
        ).mappings().one()
    assert row["owner_user_id"] == "u1"
    assert row["source"] == "manual"
