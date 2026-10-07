"""UTC DateTime persistence and indexed range scans."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import Column, MetaData, Table, select
from sqlalchemy.exc import StatementError

from prepforge_chess.core.models import Color, TrainingProgress
from prepforge_chess.storage.database import initialize_database, connect_database
from prepforge_chess.storage.datetime_type import UTCDateTime
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def test_training_progress_round_trips_aware_datetimes():
    """Progress saves and typed Core reads return aware UTC instants."""
    engine = initialize_database(":memory:")
    repo = WorkspaceRepository(engine)
    builder_repo = WorkspaceRepository(engine)
    from prepforge_chess.core.models import OpeningNode, Repertoire
    from prepforge_chess.core.chess_core import STARTING_FEN
    import uuid

    rep = Repertoire(
        id=str(uuid.uuid4()),
        name="dt",
        color=Color.WHITE,
        root_fen=STARTING_FEN,
        root_node=OpeningNode(
            id=str(uuid.uuid4()),
            repertoire_id="",
            fen=STARTING_FEN,
            side_to_move=Color.WHITE,
        ),
    )
    rep.root_node.repertoire_id = rep.id
    builder_repo.save_repertoire(rep, owner_user_id="user-dt")

    reviewed = datetime(2026, 6, 11, 9, 30, 0, tzinfo=timezone.utc)
    due = reviewed + timedelta(days=3)
    progress = TrainingProgress(
        node_id="node-dt",
        attempts=2,
        correct_attempts=2,
        last_reviewed_at=reviewed,
        spaced_repetition_score=4.0,
        due_at=due,
    )
    repo.save_training_progress(rep.id, progress, owner_user_id="user-dt")

    loaded = repo.load_training_progress(
        rep.id, "node-dt", owner_user_id="user-dt"
    )
    assert loaded is not None
    assert loaded.last_reviewed_at == reviewed
    assert loaded.last_reviewed_at.tzinfo is not None
    assert loaded.due_at == due

    from prepforge_chess.storage import sa_tables as t
    from sqlalchemy import select
    with engine.connect() as conn:
        row = conn.execute(select(t.training_progress)).mappings().one()
    assert row["due_at"] == due
    assert row["last_reviewed_at"] == reviewed
    assert row["updated_at"].utcoffset() == timedelta(0)
    engine.dispose()


def test_type_normalizes_offsets_preserves_microseconds_and_orders_ranges():
    engine = connect_database()
    table = Table("instants", MetaData(), Column("instant", UTCDateTime(), primary_key=True))
    table.metadata.create_all(engine)
    stamp = datetime(2026, 1, 2, 1, 0, 0, 123456, tzinfo=timezone(timedelta(hours=5)))
    utc = stamp.astimezone(timezone.utc)
    with engine.begin() as conn:
        conn.execute(table.insert(), [{"instant": stamp}, {"instant": utc + timedelta(seconds=1)}])
        assert conn.scalars(select(table.c.instant).where(table.c.instant <= utc)).all() == [utc]
        loaded = conn.scalars(select(table.c.instant).order_by(table.c.instant)).all()
    assert all(value.utcoffset() == timedelta(0) for value in loaded)
    engine.dispose()


@pytest.mark.parametrize("value", [datetime(2026, 1, 1), "2026-01-01T00:00:00Z"])
def test_type_rejects_non_aware_inputs(value):
    engine = connect_database()
    table = Table("instants", MetaData(), Column("instant", UTCDateTime()))
    table.metadata.create_all(engine)
    with engine.begin() as conn, pytest.raises(StatementError):
        conn.execute(table.insert().values(instant=value))
    engine.dispose()


def test_due_range_uses_due_index():
    from prepforge_chess.storage import sa_tables as t
    engine = initialize_database(":memory:")
    query = select(t.training_progress.c.id).where(t.training_progress.c.due_at <= datetime.now(timezone.utc))
    sql = str(query.compile(engine, compile_kwargs={"literal_binds": True}))
    with engine.connect() as conn:
        plan = " ".join(str(row) for row in conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql))
    assert "SEARCH training_progress USING INDEX idx_training_progress_due (due_at<?)" in plan
    engine.dispose()
