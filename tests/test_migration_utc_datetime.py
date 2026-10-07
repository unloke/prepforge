"""Fresh and populated upgrades preserve UTC instants and referential integrity."""
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import subprocess
import sys

import pytest
from sqlalchemy import DateTime, MetaData, Table, create_engine, inspect, select

from prepforge_chess.storage import sa_tables as t


def _upgrade(path, revision):
    env = dict(os.environ, DATABASE_URL=f"sqlite:///{path.as_posix()}")
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("seeded", [False, True])
def test_datetime_upgrade(tmp_path, seeded):
    path = tmp_path / "timestamps.sqlite3"
    expected = datetime(2026, 1, 1, 20, 30, 0, 123456, tzinfo=timezone.utc)
    offset_stamp = expected.astimezone(timezone(timedelta(hours=5, minutes=30))).isoformat()
    values = {
        "users": {"id": "owner", "email": "owner@example.com", "plan": "free"},
        "linked_accounts": {"id": "link", "user_id": "owner", "provider": "lichess",
                            "provider_user_id": "player", "is_primary": True},
        "teams": {"id": "team", "name": "Team", "owner_user_id": "owner", "kind": "team"},
        "team_members": {"id": "member", "team_id": "team", "user_id": "owner", "role": "member"},
        "team_invites": {"id": "invite", "team_id": "team", "code_hash": "code",
                         "created_by_user_id": "owner"},
        "password_reset_tokens": {"id": "reset", "user_id": "owner", "token_hash": "reset-token"},
        "stripe_events": {"id": "event", "type": "customer.updated"},
        "auth_sessions": {"token_hash": "token", "user_id": "owner"},
        "games": {"id": "game", "source": "manual", "initial_fen": "fen", "uci_blob": "",
                  "result": "*", "tags_json": "{}", "owner_user_id": "owner"},
        "analysis_results": {"id": "analysis", "game_id": "game", "engine": "engine",
                             "summary_json": "{}", "critical_ply": ""},
        "repertoires": {"id": "rep", "owner_user_id": "owner", "name": "Rep", "color": "white",
                        "root_fen": "fen", "root_node_id": "node", "tags_json": "[]", "is_active": 1},
        "opening_nodes": {"id": "node", "repertoire_id": "rep", "is_mainline": 1,
                          "is_user_prepared_move": 1, "is_enabled": 1, "priority": 1.0, "source": "manual"},
        "training_sessions": {"id": "session", "repertoire_id": "rep", "mode": "smart",
                              "line_order_json": "[]", "current_index": 0, "current_node_id": "node",
                              "mistakes_json": "{}", "mastered_nodes_json": "[]"},
        "training_progress": {"id": "progress", "owner_user_id": "owner", "repertoire_id": "rep",
                              "node_id": "node", "attempts": 1, "correct_attempts": 1,
                              "spaced_repetition_score": 1.0, "is_mastered": 0},
        "user_settings": {"user_id": "owner", "key": "setting", "value_json": "{}"},
        "train_attempt_receipts": {"session_id": "session", "attempt_uuid": "attempt",
                                   "node_id": "node", "correct": True},
    }
    if seeded:
        _upgrade(path, "b82d4f9031ac")
        engine = create_engine(f"sqlite:///{path.as_posix()}")
        with engine.begin() as conn:
            for name, row in values.items():
                table = Table(name, MetaData(), autoload_with=conn)
                for column in table.c:
                    if column.name.endswith("_at"):
                        # Previous identity DateTime storage is naive UTC;
                        # text domain timestamps exercise nonzero offsets.
                        row[column.name] = expected if isinstance(column.type, DateTime) else offset_stamp
                if name == "games":
                    row["played_at"] = None
                if name == "training_progress":
                    row["last_reviewed_at"] = expected.replace(tzinfo=None).isoformat()
                if name == "password_reset_tokens":
                    row["used_at"] = None
                conn.execute(table.insert().values(**row))
        engine.dispose()

    _upgrade(path, "head")
    engine = create_engine(f"sqlite:///{path.as_posix()}")
    with engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        for name in values:
            columns = inspect(conn).get_columns(name)
            assert all(str(c["type"]) == "DATETIME" for c in columns if c["name"].endswith("_at"))
            if seeded:
                row = conn.execute(select(t.metadata.tables[name])).mappings().one()
                for column, value in row.items():
                    if column.endswith("_at"):
                        nullable_stamp = ((name == "games" and column == "played_at")
                                          or (name == "password_reset_tokens" and column == "used_at"))
                        assert value == (None if nullable_stamp else expected)
                        if value is not None:
                            stored = conn.exec_driver_sql(f'SELECT "{column}" FROM "{name}"').scalar_one()
                            assert stored.endswith(".123456+00:00")
                for column, value in values[name].items():
                    if not column.endswith("_at"):
                        assert row[column] == value
        indexes = {index["name"] for index in inspect(conn).get_indexes("training_progress")}
        assert "idx_training_progress_due" in indexes
        plan = str(conn.exec_driver_sql(
            "EXPLAIN QUERY PLAN SELECT id FROM training_progress WHERE due_at <= ?",
            ("2026-01-02 00:00:00.000000",),
        ).all())
        assert "idx_training_progress_due (due_at<?)" in plan
        if seeded:
            assert conn.scalars(select(t.training_progress.c.id).where(t.training_progress.c.due_at <= expected)).all() == ["progress"]
    engine.dispose()
