from datetime import datetime, timezone

from prepforge_chess.core.models import Color, MoveSource, TrainingMode, TrainingProgress
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.training import (
    TrainingService,
    create_training_session,
    record_attempt,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def _training_repository():
    connection = connect_database()
    apply_schema(connection)
    return WorkspaceRepository(connection)


def _training_repertoire(repository):
    builder = OpeningBuilderService(repository)
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Trainer Demo", color=Color.WHITE)
    )
    e4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "e2e4",
        is_mainline=True,
        is_user_prepared_move=True,
    )
    e5 = builder.add_move(
        repertoire.id,
        e4.id,
        "e7e5",
        source=MoveSource.GENERATED_MAIA3,
        is_mainline=True,
    )
    builder.add_move(
        repertoire.id,
        e5.id,
        "g1f3",
        is_mainline=True,
        is_user_prepared_move=True,
    )
    d4 = builder.add_move(
        repertoire.id,
        repertoire.root_node.id,
        "d2d4",
        is_user_prepared_move=True,
    )
    d5 = builder.add_move(
        repertoire.id,
        d4.id,
        "d7d5",
        source=MoveSource.GENERATED_MAIA3,
    )
    builder.add_move(
        repertoire.id,
        d5.id,
        "c2c4",
        is_user_prepared_move=True,
    )
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded


def test_training_order_is_repeatable_with_seed():
    first = create_training_session(
        repertoire_id="rep",
        owner_user_id="u1",
        line_ids=["a", "b", "c", "d"],
        mode=TrainingMode.ALL_LINES,
        seed=7,
    )
    second = create_training_session(
        repertoire_id="rep",
        owner_user_id="u1",
        line_ids=["a", "b", "c", "d"],
        mode=TrainingMode.ALL_LINES,
        seed=7,
    )

    assert first.line_order == second.line_order
    assert first.seed == 7


def test_wrong_attempt_adds_mistake_and_due_soon():
    session = create_training_session(
        repertoire_id="rep",
        owner_user_id="u1",
        line_ids=["line"],
        mode=TrainingMode.ALL_LINES,
        seed=1,
    )
    progress = TrainingProgress(node_id="node")
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    updated_session, updated_progress = record_attempt(
        session=session,
        progress=progress,
        node_id="node",
        correct=False,
        now=now,
    )

    assert updated_session.mistakes == ["node"]
    assert updated_progress.attempts == 1
    assert updated_progress.due_at is not None
    assert updated_progress.due_at > now


def test_training_service_starts_and_resumes_saved_line_order():
    repository = _training_repository()
    repertoire = _training_repertoire(repository)
    service = TrainingService(repository, "t-owner")

    first = service.start_or_resume_session(
        repertoire.id,
        mode=TrainingMode.ALL_LINES,
        seed=11,
    )
    second = service.start_or_resume_session(
        repertoire.id,
        mode=TrainingMode.ALL_LINES,
        seed=99,
    )

    assert first.id == second.id
    assert first.seed == 11
    assert len(first.line_order) == 2
    assert first.line_order == second.line_order


def test_training_service_wrong_then_correct_attempt_updates_queue_and_prompt():
    repository = _training_repository()
    repertoire = _training_repertoire(repository)
    service = TrainingService(repository, "t-owner")
    session = service.start_or_resume_session(repertoire.id, seed=1)
    prompt = service.current_prompt(session.id)
    assert prompt is not None

    wrong = "a2a3" if prompt.expected_move_uci != "a2a3" else "h2h3"
    wrong_result = service.submit_move(session.id, wrong)

    assert not wrong_result.correct
    assert wrong_result.expected_san == prompt.expected_move_san
    assert wrong_result.session.mistakes == [prompt.expected_node_id]
    assert wrong_result.next_prompt is not None
    assert wrong_result.next_prompt.expected_node_id == prompt.expected_node_id

    correct_result = service.submit_move(session.id, prompt.expected_move_uci)

    assert correct_result.correct
    assert correct_result.session.mistakes == []
    assert correct_result.progress.correct_attempts == 1
    assert correct_result.next_prompt is not None
    assert correct_result.next_prompt.expected_node_id != prompt.expected_node_id


def test_rehearsal_grades_only_the_first_attempt_at_a_prompt():
    """Line rehearsal shares the smart queue's wrong-move rule: a retry (and the
    move played after the reveal) moves on without another SR write."""
    from prepforge_chess.core.models import Color
    from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
    from prepforge_chess.services.training import TrainingService
    from prepforge_chess.storage.database import apply_schema, connect_database
    from prepforge_chess.storage.repositories.workspace import WorkspaceRepository

    connection = connect_database()
    apply_schema(connection)
    repository = WorkspaceRepository(connection)
    builder = OpeningBuilderService(repository)
    rep = builder.create_repertoire(CreateRepertoireRequest(name="R", color=Color.WHITE))
    e4 = builder.add_move(rep.id, rep.root_node.id, "e2e4", is_user_prepared_move=True)
    builder.add_move(rep.id, e4.id, "e7e5")
    service = TrainingService(repository, "owner")
    session = service.start_or_resume_session(rep.id)
    assert service.submit_move(session.id, "d2d4", attempt=1).progress.attempts == 1
    retry = service.submit_move(session.id, "d2d4", attempt=2)
    assert retry.progress is None and retry.correct is False
    done = service.submit_move(session.id, "e2e4", attempt=3)
    assert done.correct and done.progress is None
    stored = repository.load_training_progress(rep.id, e4.id, owner_user_id="owner")
    assert (stored.attempts, stored.correct_attempts) == (1, 0)


def test_rehearsal_accepts_another_repertoire_move_without_grading():
    """1.e4 and 1.d4 are both in the repertoire: playing d4 on the e4 line is not
    a miss. Nothing is graded, the prompt stays, and the next try still grades."""
    repository = _training_repository()
    repertoire = _training_repertoire(repository)
    service = TrainingService(repository, "t-owner")
    session = service.start_or_resume_session(repertoire.id, seed=1)
    prompt = service.current_prompt(session.id)
    other = "d2d4" if prompt.expected_move_uci == "e2e4" else "e2e4"

    result = service.submit_move(session.id, other, attempt=1)

    assert result.alternative is True and result.correct is False
    assert result.progress is None
    assert result.session.mistakes == []
    assert result.played_san in {"d4", "e4"}
    assert result.next_prompt.expected_node_id == prompt.expected_node_id
    assert repository.load_training_progress(
        repertoire.id, prompt.expected_node_id, owner_user_id="t-owner"
    ) is None
    graded = service.submit_move(session.id, prompt.expected_move_uci, attempt=1)
    assert graded.correct and graded.progress.attempts == 1
