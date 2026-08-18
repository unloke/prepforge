"""Drift guard: SQLAlchemy domain schema must match schema.sql."""
from __future__ import annotations

import sqlite3

from sqlalchemy import create_engine, inspect

from prepforge_chess.storage import sa_tables
from prepforge_chess.storage.database import SCHEMA_PATH

DOMAIN_TABLES = {
    "user_profiles",
    "games",
    "positions",
    "engine_evaluations",
    "moves",
    "analysis_results",
    "repertoires",
    "opening_nodes",
    "training_sessions",
    "training_progress",
    "engine_settings",
    "app_settings",
    "user_sessions",
}


def _schema_sql_columns() -> dict[str, set[str]]:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        out: dict[str, set[str]] = {}
        for table in DOMAIN_TABLES:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
            out[table] = {row["name"] for row in rows}
        return out
    finally:
        conn.close()


def _sqlalchemy_columns() -> dict[str, set[str]]:
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))
    insp = inspect(engine)
    return {t: {c["name"] for c in insp.get_columns(t)} for t in DOMAIN_TABLES}


def test_sa_schema_defines_every_domain_table():
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))
    created = set(inspect(engine).get_table_names())
    missing = DOMAIN_TABLES - created
    assert not missing, f"sa_tables is missing domain tables: {sorted(missing)}"
    obsolete = {
        "maia_predictions",
        "opening_lines",
        "generation_runs",
        "lichess_imports",
        "practical_opening_matches",
        "training_mistakes",
    } & created
    assert not obsolete, f"obsolete tables still created: {sorted(obsolete)}"


def test_sa_columns_match_schema_sql():
    sql_cols = _schema_sql_columns()
    sa = _sqlalchemy_columns()
    for table in sorted(DOMAIN_TABLES):
        assert sa[table] == sql_cols[table], (
            f"{table}: sa-only={sorted(sa[table] - sql_cols[table])}, "
            f"schema.sql-only={sorted(sql_cols[table] - sa[table])}"
        )


def test_sa_games_round_trip():
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine, tables=list(sa_tables.DOMAIN_TABLES))
    with engine.begin() as conn:
        conn.execute(
            sa_tables.games.insert(),
            {
                "id": "g1",
                "source": "manual",
                "initial_fen": "startpos",
                "uci_blob": "e2e4 e7e5",
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
    assert row["uci_blob"] == "e2e4 e7e5"
    assert "pgn" not in row
