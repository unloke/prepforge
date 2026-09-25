"""Characterization: canonical datetime persistence in the domain (Core) tables.

Domain tables store datetimes as ISO-8601 TEXT (see storage/sa_tables.py). The
dashboard's due-review queries compare those strings LEXICALLY
(``due_at <= now_iso``), so the canonical on-disk format is load-bearing:

* every persisted datetime must be timezone-aware UTC,
* the text must round-trip through ``_dt_to_text`` / ``_dt_from_text`` unchanged,
* a datetime written via a repo save must read back equal after the naive ->
  aware coercion the loaders apply (SQLite hands back what we wrote),
* strings written at different times must order correctly under lexical
  comparison (that is what ``due_at <= now_iso`` relies on).

These tests pin the current behavior; they are not a redesign.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from prepforge_chess.core.models import Color, TrainingProgress, utc_now
from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories import (
    PrepForgeRepository,
    _dt_from_text,
    _dt_to_text,
    _now_text,
)


def test_now_text_is_canonical_utc_iso():
    """_now_text (created_at/updated_at) is timezone-aware UTC ISO-8601."""
    text = _now_text()
    parsed = datetime.fromisoformat(text)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timedelta(0)
    # +00:00 suffix (isoformat of an aware UTC datetime), not a bare naive stamp.
    assert text.endswith("+00:00")


def test_dt_text_round_trip_preserves_instant():
    naive = datetime(2026, 6, 11, 12, 0, 0)
    aware = naive.replace(tzinfo=timezone.utc)
    text = _dt_to_text(aware)
    assert text == "2026-06-11T12:00:00+00:00"
    back = _dt_from_text(text)
    assert back == aware
    assert back.tzinfo is not None


def test_dt_to_text_none_stays_none():
    assert _dt_to_text(None) is None
    assert _dt_from_text(None) is None
    assert _dt_from_text("") is None


def test_training_progress_round_trips_canonical_text():
    """last_reviewed_at / due_at survive a repo save + load as the same aware
    UTC instants, and the stored TEXT is the canonical +00:00 ISO form."""
    engine = initialize_database(":memory:")
    repo = PrepForgeRepository(engine)
    builder_repo = PrepForgeRepository(engine)
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

    # The stored text is canonical: a raw read shows the +00:00 suffix, which is
    # what makes the dashboard's lexical `due_at <= now_iso` comparisons valid.
    from prepforge_chess.storage import sa_tables as t
    from sqlalchemy import select

    with engine.connect() as conn:
        row = conn.execute(
            select(t.training_progress).where(
                t.training_progress.c.node_id == "node-dt"
            )
        ).mappings().first()
    assert row["due_at"].endswith("+00:00")
    assert row["last_reviewed_at"].endswith("+00:00")
    engine.dispose()


def test_lexical_ordering_matches_chronological_ordering():
    """ISO-8601 UTC stamps from different days/hours compare identically as text
    and as datetimes — the property the dashboard SQL depends on."""
    stamps = [
        datetime(2026, 6, 9, 23, 59, 59, tzinfo=timezone.utc),
        datetime(2026, 6, 10, 0, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 11, 12, 30, 0, tzinfo=timezone.utc),
        utc_now(),
    ]
    texts = [_dt_to_text(s) for s in stamps]
    assert texts == sorted(texts)
    assert stamps == sorted(stamps)
    # And the dashboard's predicate shape works on the text directly:
    cutoff = _now_text()
    past = [s for s, t in zip(stamps, texts) if t <= cutoff]
    assert past == [s for s in stamps if s <= datetime.fromisoformat(cutoff)]
