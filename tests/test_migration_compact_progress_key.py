"""Forward migration e6b8f0a2c4d7: training_progress re-keyed onto (owner, node).

Builds a database at the previous revision with real progress rows, upgrades to
head, and checks every row kept its counters while the derived id, the two
unread timestamps and the redundant indexes are gone.
"""
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api import config as app_config

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS = "d5a7e9f1b3c6"
STAMP = "'2026-01-01'"


@pytest.fixture()
def migrate(tmp_path, monkeypatch):
    db_file = tmp_path / "progress_key.sqlite3"
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


def test_upgrade_rekeys_progress_without_losing_counters(migrate):
    engine, cfg = migrate
    with engine.begin() as conn:
        conn.execute(sa.text(
            f"INSERT INTO users (id, email, plan, created_at, updated_at) "
            f"VALUES ('u1', 'u1@x.test', 'free', {STAMP}, {STAMP})"
        ))
        conn.execute(sa.text(
            "INSERT INTO repertoires (id, owner_user_id, name, color, root_fen, tags_json,"
            f" is_active, created_at, updated_at) VALUES ('r1', 'u1', 'Mine', 'white', 'fen', '[]', 1, {STAMP}, {STAMP})"
        ))
        conn.execute(sa.text(
            "INSERT INTO opening_nodes (id, repertoire_id, is_mainline, is_user_prepared_move,"
            " is_enabled, priority, source, created_at, updated_at)"
            f" VALUES ('n1', 'r1', 1, 1, 1, 1.0, 'manual', {STAMP}, {STAMP})"
        ))
        conn.execute(sa.text(
            "INSERT INTO training_progress (id, owner_user_id, repertoire_id, node_id, attempts,"
            " correct_attempts, spaced_repetition_score, is_mastered, created_at, updated_at)"
            " VALUES ('training-progress:abc', 'u1', 'r1', 'n1', 7, 5, 3.5, 1, :stamp, :stamp)"
        ), {"stamp": "2026-01-01 00:00:00.000000+00:00"})

    command.upgrade(cfg, "head")

    with engine.connect() as conn:
        columns = {row[1] for row in conn.execute(sa.text("PRAGMA table_info(training_progress)"))}
        row = conn.execute(sa.text(
            "SELECT owner_user_id, repertoire_id, node_id, attempts, correct_attempts,"
            " spaced_repetition_score, is_mastered FROM training_progress"
        )).mappings().one()
        indexes = {i["name"] for i in sa.inspect(conn).get_indexes("training_progress")}
    assert columns == {
        "owner_user_id", "repertoire_id", "node_id", "attempts", "correct_attempts",
        "last_reviewed_at", "spaced_repetition_score", "due_at", "is_mastered",
    }
    assert dict(row) == {
        "owner_user_id": "u1", "repertoire_id": "r1", "node_id": "n1",
        "attempts": 7, "correct_attempts": 5, "spaced_repetition_score": 3.5, "is_mastered": 1,
    }
    assert indexes == {"idx_training_progress_due", "idx_training_progress_owner"}
    assert sa.inspect(engine).get_pk_constraint("training_progress")["constrained_columns"] == [
        "node_id", "owner_user_id",
    ]


def test_node_cascade_lookup_seeks_the_primary_key(migrate):
    """The d4e6f8a0b2c3 cascade index exists because deleting a node looks up
    its progress by node_id; leading the key with node_id keeps that a seek."""
    engine, cfg = migrate
    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        plan = [row[3] for row in conn.exec_driver_sql(
            "EXPLAIN QUERY PLAN SELECT node_id FROM training_progress WHERE node_id = 'n1'"
        )]
    assert any("training_progress_1 (node_id=?)" in step or "PRIMARY KEY" in step for step in plan), plan
