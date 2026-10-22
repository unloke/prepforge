"""528e704717a9: score-based progress converts to FSRS state without losing any."""
from datetime import datetime, timedelta, timezone

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from prepforge_chess.api.config import get_settings

BEFORE = "e9c1d3f5a7b9"
REVIEWED = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def migrated(tmp_path, monkeypatch):
    url = "sqlite:///" + str(tmp_path / "fsrs.sqlite3")
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    cfg = Config("alembic.ini")
    command.upgrade(cfg, BEFORE)
    engine = sa.create_engine(url)
    try:
        yield cfg, engine
    finally:
        engine.dispose()
        get_settings.cache_clear()


def _seed(engine):
    rows = {
        "users": [{"id": "u", "email": "u@example.com", "plan": "free"}],
        "repertoires": [{"id": "rep", "owner_user_id": "u", "name": "Rep", "color": "white",
                         "root_fen": "fen", "root_node_id": "root", "tags_json": "[]", "is_active": 1}],
        "opening_nodes": [
            {"id": nid, "repertoire_id": "rep", "is_mainline": 1, "is_user_prepared_move": 1,
             "is_enabled": 1, "priority": 1.0, "source": "manual"}
            for nid in ("solid", "missed", "fresh")
        ],
        "training_progress": [
            # Six straight hits: the old interval was 6 days.
            {"node_id": "solid", "attempts": 6, "correct_attempts": 6, "spaced_repetition_score": 6.0,
             "is_mastered": 0, "due_at": REVIEWED + timedelta(days=6)},
            # Just missed: score halved below FSRS's first-miss stability.
            {"node_id": "missed", "attempts": 4, "correct_attempts": 1, "spaced_repetition_score": 0.1,
             "is_mastered": 0, "due_at": REVIEWED + timedelta(minutes=10)},
            # Claimed but never answered.
            {"node_id": "fresh", "attempts": 0, "correct_attempts": 0, "spaced_repetition_score": 0.0,
             "is_mastered": 0, "due_at": None},
        ],
    }
    with engine.begin() as conn:
        for name, entries in rows.items():
            table = sa.Table(name, sa.MetaData(), autoload_with=conn)
            for entry in entries:
                if name == "training_progress":
                    entry = {"owner_user_id": "u", "repertoire_id": "rep",
                             "last_reviewed_at": REVIEWED if entry["attempts"] else None, **entry}
                stamps = {c.name: REVIEWED for c in table.c if c.name.endswith("_at") and not c.nullable}
                conn.execute(table.insert().values(**{**stamps, **entry}))


def _progress(engine):
    with engine.connect() as conn:
        table = sa.Table("training_progress", sa.MetaData(), autoload_with=conn)
        return {row["node_id"]: dict(row) for row in conn.execute(sa.select(table)).mappings()}


def test_upgrade_backfills_fsrs_state_and_downgrade_restores_scores(migrated):
    cfg, engine = migrated
    _seed(engine)
    before = _progress(engine)

    command.upgrade(cfg, "head")
    rows = _progress(engine)
    assert "spaced_repetition_score" not in rows["solid"] and "is_mastered" not in rows["solid"]
    solid, missed, fresh = rows["solid"], rows["missed"], rows["fresh"]
    assert (solid["state"], solid["step"], solid["stability"], solid["lapses"]) == (2, None, 6.0, 0)
    assert solid["difficulty"] == pytest.approx(2.1181)
    assert (missed["state"], missed["stability"], missed["lapses"]) == (2, 0.212, 3)
    assert missed["difficulty"] == pytest.approx(2.1181 + 0.75 * (6.4133 - 2.1181))
    assert (fresh["state"], fresh["stability"], fresh["difficulty"], fresh["lapses"]) == (0, None, None, 0)
    for node_id, row in rows.items():  # counts and schedule are untouched
        for column in ("attempts", "correct_attempts", "last_reviewed_at", "due_at"):
            assert row[column] == before[node_id][column]
    with engine.connect() as conn:
        assert "train_reviews" in sa.inspect(conn).get_table_names()

    command.downgrade(cfg, BEFORE)
    rows = _progress(engine)
    assert "state" not in rows["solid"]
    assert sa.inspect(engine).has_table("train_reviews") is False
    assert rows["solid"]["spaced_repetition_score"] == 6.0
    assert rows["missed"]["spaced_repetition_score"] == 0.212
    assert rows["fresh"]["spaced_repetition_score"] == 0.0
    assert [rows[n]["attempts"] for n in ("solid", "missed", "fresh")] == [6, 4, 0]

    command.upgrade(cfg, "head")
    assert _progress(engine)["solid"]["stability"] == 6.0
