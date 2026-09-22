"""Alembic is the sole production schema authority.

This module asserts that every table Alembic manages matches the SQLAlchemy
metadata that defines it: no second production schema lifecycle (no runtime
``create_all`` patching, no ``schema.sql`` fixture). The ephemeral helper
(``storage.database``) exists only for throwaway SQLite engines in CLI smoke
paths and non-API unit tests.
"""
from __future__ import annotations

from sqlalchemy import create_engine, inspect

from prepforge_chess.api import models  # noqa: F401  (registers ORM tables)
from prepforge_chess.storage import sa_tables


def _expected_tables() -> set[str]:
    return {
        # ORM identity/session/settings/receipts.
        "users",
        "auth_sessions",
        "linked_accounts",
        "teams",
        "team_members",
        "team_invites",
        "stripe_events",
        "user_settings",
        "train_attempt_receipts",
        # Core domain tables.
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
        "alembic_version",
    }


def _migrated_columns() -> dict[str, set[str]]:
    import os
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory() as tmp:
        db_file = Path(tmp) / "drift_check.sqlite3"
        env = os.environ.copy()
        env["DATABASE_URL"] = "sqlite:///{0}".format(db_file.as_posix())
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, "alembic upgrade head failed:\n{0}".format(
            result.stderr or result.stdout
        )
        import sqlite3

        conn = sqlite3.connect(db_file)
        try:
            out: dict[str, set[str]] = {}
            for (name,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall():
                cols = conn.execute("PRAGMA table_info({0})".format(name)).fetchall()
                out[name] = {row[1] for row in cols}
            return out
        finally:
            conn.close()


def _sqlalchemy_columns() -> dict[str, set[str]]:
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine)
    insp = inspect(engine)
    return {t: {c["name"] for c in insp.get_columns(t)} for t in insp.get_table_names()}


def test_no_legacy_identity_tables():
    cols = _migrated_columns()
    assert "user_profiles" not in cols
    assert "user_sessions" not in cols


def test_migrated_schema_matches_metadata():
    """Every Alembic-managed table matches the metadata column set.

    ``alembic_version`` is migration bookkeeping (no metadata equivalent) and
    is asserted separately in ``test_expected_tables``.
    """
    migrated = _migrated_columns()
    sa = _sqlalchemy_columns()
    for table in sorted(set(migrated) & set(sa)):
        assert sa[table] == migrated[table], (
            "{0}: sa-only={1}, migrated-only={2}".format(
                table,
                sorted(sa[table] - migrated[table]),
                sorted(migrated[table] - sa[table]),
            )
        )


def test_expected_tables():
    assert set(_migrated_columns()) == _expected_tables()


def test_sa_games_round_trip():
    engine = create_engine("sqlite://")
    sa_tables.metadata.create_all(engine)
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
