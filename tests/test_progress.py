from datetime import datetime, timedelta, timezone

from prepforge_chess.core.models import Color, MoveSource, TrainingMode, TrainingProgress
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.progress import (
    MASTERY_DUE,
    MASTERY_MASTERED,
    MASTERY_UNTRAINED,
    MASTERY_WEAK,
    compute_health,
    due_node_ids,
    node_mastery,
)
from prepforge_chess.services.training import TrainingService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia


def _repo():
    connection = connect_database()
    apply_schema(connection)
    return PrepForgeRepository(connection)


def _repertoire_with_ids(repository):
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Health Demo", color=Color.WHITE)
    )
    e4 = builder.add_move(
        repertoire.id, repertoire.root_node.id, "e2e4",
        is_mainline=True, is_user_prepared_move=True,
    )
    e5 = builder.add_move(
        repertoire.id, e4.id, "e7e5", source=MoveSource.GENERATED_MAIA3, is_mainline=True,
    )
    nf3 = builder.add_move(
        repertoire.id, e5.id, "g1f3", is_mainline=True, is_user_prepared_move=True,
    )
    d4 = builder.add_move(
        repertoire.id, repertoire.root_node.id, "d2d4", is_user_prepared_move=True,
    )
    d5 = builder.add_move(
        repertoire.id, d4.id, "d7d5", source=MoveSource.GENERATED_MAIA3,
    )
    builder.add_move(
        repertoire.id, d5.id, "c2c4", is_user_prepared_move=True,
    )
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded, {"e4": e4.id, "nf3": nf3.id, "d4": d4.id}


def test_node_mastery_states():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert node_mastery(None, now=now) == MASTERY_UNTRAINED
    assert node_mastery(TrainingProgress(node_id="n"), now=now) == MASTERY_UNTRAINED
    assert node_mastery(
        TrainingProgress(node_id="n", attempts=4, correct_attempts=1), now=now
    ) == MASTERY_WEAK
    assert node_mastery(
        TrainingProgress(
            node_id="n", attempts=5, correct_attempts=5,
            spaced_repetition_score=8.0, is_mastered=True,
        ),
        now=now,
    ) == MASTERY_MASTERED
    due = TrainingProgress(
        node_id="n", attempts=2, correct_attempts=2,
        due_at=now - timedelta(days=1), spaced_repetition_score=2.0,
    )
    assert node_mastery(due, now=now) == MASTERY_DUE


def test_compute_health_counts_each_state():
    repository = _repo()
    repertoire, ids = _repertoire_with_ids(repository)
    past = datetime.now(timezone.utc) - timedelta(days=1)

    repository.save_training_progress(repertoire.id, TrainingProgress(
        node_id=ids["e4"], attempts=5, correct_attempts=5,
        spaced_repetition_score=8.0, is_mastered=True,
    ))
    repository.save_training_progress(repertoire.id, TrainingProgress(
        node_id=ids["d4"], attempts=4, correct_attempts=1,
    ))
    repository.save_training_progress(repertoire.id, TrainingProgress(
        node_id=ids["nf3"], attempts=2, correct_attempts=2,
        due_at=past, spaced_repetition_score=2.0,
    ))

    progress = {p.node_id: p for p in repository.list_training_progress(repertoire.id)}
    health = compute_health(repertoire.root_node, repertoire.color, progress)

    assert health.trainable == 4  # e4, Nf3, d4, c4 (white own-moves)
    assert health.mastered == 1
    assert health.weak == 1
    assert health.due == 1
    assert health.untrained == 1
    assert health.mastery_pct == 25


def test_due_node_ids_only_picks_due():
    now = datetime.now(timezone.utc)
    progress = [
        TrainingProgress(node_id="past", due_at=now - timedelta(days=1)),
        TrainingProgress(node_id="future", due_at=now + timedelta(days=1)),
        TrainingProgress(node_id="never", due_at=None),
    ]
    assert due_node_ids(progress, now=now) == {"past"}


def test_due_review_mode_selects_lines_with_due_nodes():
    repository = _repo()
    repertoire, ids = _repertoire_with_ids(repository)
    past = datetime.now(timezone.utc) - timedelta(days=1)
    repository.save_training_progress(repertoire.id, TrainingProgress(
        node_id=ids["nf3"], attempts=2, correct_attempts=1, due_at=past,
    ))

    service = TrainingService(repository)
    lines = service.training_lines(repertoire, TrainingMode.MISTAKES_ONLY)

    # Only the e4-e5-Nf3 line passes through the due node.
    assert len(lines) == 1
    assert ids["nf3"] in lines[0].node_ids
