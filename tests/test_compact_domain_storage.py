"""b9e1f3a5c7d0 leaves the domain schema in its final, compact shape.

There is no conversion to test: the migration is the only forward change, it
carries no backfill, and no earlier data shape is supported. These tests pin
what the schema *is* after `alembic upgrade head` — the columns, keys and
indexes each of the six former migrations left behind — and that the chain
still applies cleanly on a fresh database.
"""
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api import config as app_config

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def migrated(tmp_path, monkeypatch):
    db_file = tmp_path / "final_schema.sqlite3"
    url = f"sqlite:///{db_file.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("PREPFORGE_SECRET_KEY", "test-secret-not-for-prod")
    monkeypatch.setenv("PREPFORGE_TOKEN_KEY", "test-token-key-not-for-prod")
    monkeypatch.setenv("PREPFORGE_ENV", "development")
    app_config.get_settings.cache_clear()
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    command.upgrade(cfg, "head")
    engine = sa.create_engine(url)
    yield engine, cfg
    engine.dispose()
    app_config.get_settings.cache_clear()


def _columns(inspector, table):
    return {column["name"] for column in inspector.get_columns(table)}


def test_moves_hold_only_what_the_game_blob_cannot_supply(migrated):
    """The arriving UCI is games.uci_blob[ply-1]; provenance is per run."""
    engine, _cfg = migrated
    inspector = sa.inspect(engine)
    assert _columns(inspector, "moves") == {
        "game_id", "ply", "engine_eval_before_id", "engine_eval_after_id",
        "best_move_uci", "best_move_eval_id", "classification", "comment",
        "generated_comment", "tags_json", "source",
    }


def test_engine_evaluations_key_on_the_digest_alone(migrated):
    engine, _cfg = migrated
    inspector = sa.inspect(engine)
    columns = {column["name"]: column for column in inspector.get_columns("engine_evaluations")}
    assert isinstance(columns["fingerprint"]["type"], sa.LargeBinary)
    assert columns["fingerprint"]["nullable"] is False
    assert inspector.get_unique_constraints("engine_evaluations") == [
        {"name": "uq_engine_evaluations_fingerprint", "column_names": ["fingerprint"]}
    ]


def test_training_progress_is_keyed_by_node_and_owner(migrated):
    engine, _cfg = migrated
    inspector = sa.inspect(engine)
    assert _columns(inspector, "training_progress") == {
        "owner_user_id", "repertoire_id", "node_id", "attempts", "correct_attempts",
        "last_reviewed_at", "due_at", "state", "step", "stability", "difficulty", "lapses",
    }
    assert inspector.get_pk_constraint("training_progress")["constrained_columns"] == [
        "node_id", "owner_user_id",
    ]
    assert inspector.get_unique_constraints("training_progress") == []
    assert {index["name"] for index in inspector.get_indexes("training_progress")} == {
        "idx_training_progress_due", "idx_training_progress_owner",
    }


def test_opening_nodes_carry_no_timestamps_and_no_duplicate_parent_index(migrated):
    engine, _cfg = migrated
    inspector = sa.inspect(engine)
    columns = _columns(inspector, "opening_nodes")
    assert "created_at" not in columns and "updated_at" not in columns
    assert {index["name"] for index in inspector.get_indexes("opening_nodes")} == {
        "idx_opening_nodes_repertoire_parent",
    }


def test_node_delete_still_seeks_an_index(migrated):
    """d4e6f8a0b2c3 indexed the child side of cascades so deleting a node stayed
    linear. The final key shape must keep both lookups seekable: the cascade's
    ``node_id`` on training_progress, and the tree walk's parent."""
    engine, _cfg = migrated
    with engine.connect() as conn:
        progress_plan = [row[3] for row in conn.exec_driver_sql(
            "EXPLAIN QUERY PLAN SELECT node_id FROM training_progress WHERE node_id = 'n1'"
        )]
        nodes_plan = [row[3] for row in conn.exec_driver_sql(
            "EXPLAIN QUERY PLAN SELECT id FROM opening_nodes "
            "WHERE repertoire_id = 'r1' AND parent_id = 'n1'"
        )]
    assert any("(node_id=?)" in step for step in progress_plan), progress_plan
    assert any("idx_opening_nodes_repertoire_parent" in step for step in nodes_plan), nodes_plan
