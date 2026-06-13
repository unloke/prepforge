"""SmartTrainingService (Train v2 Phase 1): card session flow over a live repo.

Covers the contracts that distinguish the smart trainer from the legacy one:
run-in context instead of replaying lines from move 1, first-attempt-only
spaced-repetition grading, in-session re-queue after a second wrong attempt,
multi-target cards, resume/rebuild, and stale-card skipping.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from prepforge_chess.core.models import Color, TrainingMode, TrainingProgress
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.scheduler import CARD_DUE, decode_card
from prepforge_chess.services.training_smart import REQUEUE_GAP, SmartTrainingService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia

# start_or_resume schedules against the real clock, so due/mastered fixtures
# must be relative to it — a hardcoded date silently flips category.
NOW = datetime.now(timezone.utc)
PAST = NOW - timedelta(hours=2)


def _repository():
    connection = connect_database()
    apply_schema(connection)
    return PrepForgeRepository(connection)


def _build(repository):
    """White repertoire: e4 e5 Nf3 Nc6 Bb5 main line plus a d4 d5 c4 sideline."""
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Smart", color=Color.WHITE)
    )
    ids = {}
    e4 = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4", is_user_prepared_move=True)
    e5 = builder.add_move(repertoire.id, e4.id, "e7e5")
    nf3 = builder.add_move(repertoire.id, e5.id, "g1f3", is_user_prepared_move=True)
    nc6 = builder.add_move(repertoire.id, nf3.id, "b8c6")
    bb5 = builder.add_move(repertoire.id, nc6.id, "f1b5", is_user_prepared_move=True)
    d4 = builder.add_move(repertoire.id, repertoire.root_node.id, "d2d4", is_user_prepared_move=True)
    d5 = builder.add_move(repertoire.id, d4.id, "d7d5")
    c4 = builder.add_move(repertoire.id, d5.id, "c2c4", is_user_prepared_move=True)
    ids.update(e4=e4.id, e5=e5.id, nf3=nf3.id, nc6=nc6.id, bb5=bb5.id, d4=d4.id, d5=d5.id, c4=c4.id)
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded, ids


def _due(node_id):
    return TrainingProgress(
        node_id=node_id,
        attempts=3,
        correct_attempts=3,
        last_reviewed_at=PAST,
        spaced_repetition_score=3.0,
        due_at=PAST,
        is_mastered=False,
    )


def _mastered(node_id):
    return TrainingProgress(
        node_id=node_id,
        attempts=5,
        correct_attempts=5,
        last_reviewed_at=PAST,
        spaced_repetition_score=8.0,
        due_at=NOW + timedelta(days=5),
        is_mastered=True,
    )


def _seed_progress(repository, repertoire_id, rows):
    for row in rows:
        repository.save_training_progress(repertoire_id, row)


# ---- start / resume ---------------------------------------------------------


def test_start_builds_card_session():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    assert session.mode is TrainingMode.SMART
    assert session.line_order
    assert all(decode_card(raw) is not None for raw in session.line_order)
    counts = service.counts(session)
    assert counts["cards"] == len(session.line_order)


def test_start_resumes_unfinished_session():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    first = service.start_or_resume(repertoire.id, seed=5)
    again = service.start_or_resume(repertoire.id, seed=99)
    assert again.id == first.id
    assert again.line_order == first.line_order


def test_fresh_rebuilds_queue():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    first = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(first.id)
    service.submit_move(first.id, prompt.expected_move_uci)  # make some progress
    rebuilt = service.start_or_resume(repertoire.id, fresh=True, seed=6)
    assert rebuilt.id == first.id  # same row, rebuilt content
    assert rebuilt.current_index == 0
    assert rebuilt.seed == 6


def test_start_raises_when_nothing_trainable():
    repository = _repository()
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Empty", color=Color.WHITE)
    )
    service = SmartTrainingService(repository)
    try:
        service.start_or_resume(repertoire.id, seed=1)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "trainable" in str(exc)


# ---- prompts & run-in -------------------------------------------------------


def test_deep_card_prompt_carries_run_in_context():
    repository = _repository()
    repertoire, ids = _build(repository)
    # Only Bb5 (ply 5) is due; everything else is mastered, so the single card
    # targets Bb5 and the prompt must bring the player there via run-in moves
    # rather than asking them to replay the whole line.
    _seed_progress(
        repository,
        repertoire.id,
        [_due(ids["bb5"])]
        + [_mastered(ids[k]) for k in ("e4", "nf3", "d4", "c4")],
    )
    service = SmartTrainingService(repository)
    # session_size=1 keeps polish fill out so the queue is exactly the due card.
    session = service.start_or_resume(repertoire.id, seed=5, session_size=1)
    assert len(session.line_order) == 1
    prompt = service.current_prompt(session.id)
    assert prompt.kind == CARD_DUE
    assert prompt.expected_move_uci == "f1b5"
    # Run-in: the last plies before the target (Nf3, Nc6 at RUN_IN_PLIES=3
    # this is e5, Nf3, Nc6), ending at the prompt position.
    run_in_sans = [node.move.san for node in prompt.run_in]
    assert run_in_sans == ["e5", "Nf3", "Nc6"]
    assert prompt.start_fen != prompt.fen_before
    assert prompt.hint_piece == "Move the bishop"
    # No author annotation on the node -> heuristic strategy, flagged as such.
    assert prompt.hint_is_annotation is False


def test_prompt_flags_author_annotation():
    """A node's own strategic idea rides the hint verbatim and is flagged, so the
    client shows the author's words instead of a derived explanation."""
    repository = _repository()
    repertoire, ids = _build(repository)

    def _mark(node):
        if node.id == ids["e4"]:
            node.strategic_idea = "Stake the centre before Black settles."
        for child in node.children:
            _mark(child)

    _mark(repertoire.root_node)
    repository.save_repertoire(repertoire)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5, session_size=1)
    prompt = service.current_prompt(session.id)
    assert prompt.expected_move_uci == "e2e4"
    assert prompt.hint_is_annotation is True
    assert prompt.hint_strategy == "Stake the centre before Black settles."


def test_first_move_card_has_no_run_in():
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(
        repository,
        repertoire.id,
        [_due(ids["e4"])] + [_mastered(ids[k]) for k in ("nf3", "bb5", "d4", "c4")],
    )
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(session.id)
    assert prompt.expected_move_uci == "e2e4"
    assert prompt.run_in == []
    assert prompt.start_fen == prompt.fen_before


# ---- grading ----------------------------------------------------------------


def test_correct_first_attempt_writes_progress_and_advances():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(session.id)
    result = service.submit_move(session.id, prompt.expected_move_uci, attempt=1)
    assert result.correct is True
    assert result.sr_written is True
    assert result.progress is not None and result.progress.attempts == 1
    assert result.card_completed is True  # untrained queue = single-target cards
    assert result.session.current_index == 1
    assert result.played_san == prompt.expected_move_san
    assert result.fen_after_player
    # The opponent's reply is included so the client can animate it.
    assert result.reply_uci is not None


def test_wrong_first_attempt_records_mistake_and_stays():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(session.id)
    wrong = "a2a3" if prompt.expected_move_uci != "a2a3" else "h2h3"
    result = service.submit_move(session.id, wrong, attempt=1)
    assert result.correct is False
    assert result.sr_written is True
    assert prompt.expected_node_id in result.session.mistakes
    assert result.requeued is False
    assert result.session.current_index == session.current_index
    # The next prompt is the same position: the player retries locally.
    assert result.next_prompt.expected_node_id == prompt.expected_node_id


def test_second_wrong_attempt_requeues_without_grading():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    before = len(session.line_order)
    prompt = service.current_prompt(session.id)
    wrong = "a2a3" if prompt.expected_move_uci != "a2a3" else "h2h3"
    service.submit_move(session.id, wrong, attempt=1)
    result = service.submit_move(session.id, wrong, attempt=2)
    assert result.sr_written is False
    assert result.progress is None
    assert result.requeued is True
    assert len(result.session.line_order) == before + 1
    requeue_at = min(session.current_index + REQUEUE_GAP, before)
    assert result.session.line_order[requeue_at] == session.line_order[session.current_index]
    # A third miss on the same pending card does NOT stack another copy.
    result3 = service.submit_move(session.id, wrong, attempt=3)
    assert result3.requeued is False
    assert len(result3.session.line_order) == before + 1


def test_play_after_reveal_advances_without_sr_write():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(session.id)
    wrong = "a2a3" if prompt.expected_move_uci != "a2a3" else "h2h3"
    service.submit_move(session.id, wrong, attempt=1)
    service.submit_move(session.id, wrong, attempt=2)
    result = service.submit_move(session.id, prompt.expected_move_uci, attempt=3)
    assert result.correct is True
    assert result.sr_written is False
    assert result.progress is None
    assert result.session.current_index == session.current_index + 1
    # Only the graded first attempt reached the progress table.
    stored = repository.load_training_progress(repertoire.id, prompt.expected_node_id)
    assert stored.attempts == 1
    assert stored.correct_attempts == 0


# ---- multi-target cards -----------------------------------------------------


def test_merged_card_walks_both_targets():
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(
        repository,
        repertoire.id,
        [_due(ids["e4"]), _due(ids["nf3"])]
        + [_mastered(ids[k]) for k in ("bb5", "d4", "c4")],
    )
    service = SmartTrainingService(repository)
    # session_size=2 selects exactly the two due targets (no polish fill); they
    # are consecutive own moves on one path, so they merge into one card.
    session = service.start_or_resume(repertoire.id, seed=5, session_size=2)
    prompt = service.current_prompt(session.id)
    assert prompt.targets_total == 2
    assert prompt.expected_move_uci == "e2e4"

    first = service.submit_move(session.id, "e2e4", attempt=1)
    assert first.correct and not first.card_completed
    assert first.reply_san == "e5"  # opponent reply between the two targets
    assert first.next_prompt.expected_move_uci == "g1f3"
    assert first.next_prompt.target_index == 1

    second = service.submit_move(session.id, "g1f3", attempt=1)
    assert second.correct and second.card_completed


# ---- stale cards ------------------------------------------------------------


def test_stale_card_is_skipped():
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(
        repository,
        repertoire.id,
        [_due(ids["bb5"]), _due(ids["c4"])]
        + [_mastered(ids[k]) for k in ("e4", "nf3", "d4")],
    )
    service = SmartTrainingService(repository)
    # session_size=2 -> exactly the two due targets, one card each (they sit
    # on different paths, so no merge and no polish fill).
    session = service.start_or_resume(repertoire.id, seed=5, session_size=2)
    assert len(session.line_order) == 2
    # Build deletes the first card's target out from under the session.
    first_card = decode_card(session.line_order[0])
    repository.delete_opening_nodes(repertoire.id, [first_card.last_target_id])
    prompt = service.current_prompt(session.id)
    second_card = decode_card(session.line_order[1])
    assert prompt is not None
    assert prompt.expected_node_id == second_card.last_target_id


def test_session_completes_after_last_card():
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(
        repository,
        repertoire.id,
        [_due(ids["e4"])] + [_mastered(ids[k]) for k in ("nf3", "bb5", "d4", "c4")],
    )
    service = SmartTrainingService(repository)
    session = service.start_or_resume(repertoire.id, seed=5, session_size=1)
    assert len(session.line_order) == 1
    result = service.submit_move(session.id, "e2e4", attempt=1)
    assert result.session_completed is True
    assert result.next_prompt is None
    assert service.current_prompt(session.id) is None


# ---- mixed sessions (one queue over all active repertoires) -----------------


def _build_black(repository, owner=None):
    """Black repertoire: 1.e4 e5 2.Nf3 Nc6 (own moves e5, Nc6)."""
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="SmartBlack", color=Color.BLACK)
    )
    e4 = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4")
    e5 = builder.add_move(repertoire.id, e4.id, "e7e5", is_user_prepared_move=True)
    nf3 = builder.add_move(repertoire.id, e5.id, "g1f3")
    builder.add_move(repertoire.id, nf3.id, "b8c6", is_user_prepared_move=True)
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None
    return loaded


def _claim(repository, owner, *repertoires):
    repository.ensure_profile(owner, display_name=owner)
    for rep in repertoires:
        repository.claim_repertoire(rep.id, owner)


def test_mixed_session_spans_repertoires_in_chunks():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    owner = "owner-1"
    _claim(repository, owner, white, black)
    service = SmartTrainingService(repository)
    session = service.start_or_resume_mixed(owner, seed=5)
    cards = [decode_card(raw) for raw in session.line_order]
    assert all(card is not None and card.repertoire_id for card in cards)
    rep_ids = {card.repertoire_id for card in cards}
    assert rep_ids == {white.id, black.id}
    # The session row anchors on the smaller repertoire id (stable home).
    assert session.repertoire_id == min(white.id, black.id)
    # Grouped-but-mixed: never more than MIX_CHUNK consecutive same-rep cards
    # while another repertoire still has cards pending.
    from prepforge_chess.services.scheduler import MIX_CHUNK

    run = 1
    for prev, cur in zip(cards, cards[1:]):
        run = run + 1 if cur.repertoire_id == prev.repertoire_id else 1
        remaining_other = any(
            c.repertoire_id != cur.repertoire_id for c in cards[cards.index(cur) :]
        )
        if remaining_other:
            assert run <= MIX_CHUNK


def test_mixed_bundle_names_each_repertoire():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    owner = "owner-2"
    _claim(repository, owner, white, black)
    service = SmartTrainingService(repository)
    session = service.start_or_resume_mixed(owner, seed=5)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(session, anchor)
    assert bundle
    by_rep = {card["repertoire_id"] for card in bundle}
    assert by_rep == {white.id, black.id}
    for card in bundle:
        assert card["color"] in ("white", "black")
        assert card["repertoire_name"]
        assert card["targets"]


def test_mixed_single_active_repertoire_delegates_to_plain_start():
    repository = _repository()
    white, _ = _build(repository)
    owner = "owner-3"
    _claim(repository, owner, white)
    service = SmartTrainingService(repository)
    session = service.start_or_resume_mixed(owner, seed=5)
    assert session.repertoire_id == white.id
    cards = [decode_card(raw) for raw in session.line_order]
    assert all(card is not None and card.repertoire_id is None for card in cards)


def test_mixed_sync_routes_progress_to_each_repertoire():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    owner = "owner-4"
    _claim(repository, owner, white, black)
    service = SmartTrainingService(repository)
    session = service.start_or_resume_mixed(owner, seed=5)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(session, anchor)
    # One graded attempt on the first target of each repertoire's first card.
    picks = {}
    for card in bundle:
        picks.setdefault(card["repertoire_id"], card["targets"][0]["node_id"])
    assert set(picks) == {white.id, black.id}
    written = service.sync_progress(
        session.id,
        [{"node_id": node_id, "correct": True} for node_id in picks.values()],
    )
    assert written == 2
    for rep_id, node_id in picks.items():
        progress = repository.load_training_progress(rep_id, node_id)
        assert progress is not None and progress.attempts == 1
        other = black.id if rep_id == white.id else white.id
        assert repository.load_training_progress(other, node_id) is None


def test_mixed_ignores_foreign_repertoire_cards():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    _claim(repository, "owner-5", white)
    _claim(repository, "owner-6", black)  # belongs to someone else
    service = SmartTrainingService(repository)
    session = service.start_or_resume_mixed("owner-5", seed=5)
    # Tamper: splice a card pointing into the other owner's repertoire.
    foreign_node = black.root_node.children[0].children[0]  # ...e5 (own move)
    from dataclasses import replace as dc_replace

    tampered = dc_replace(
        session,
        line_order=session.line_order
        + ["due:{0}:{1}:{2}".format(black.id, foreign_node.id, foreign_node.id)],
    )
    repository.save_training_session(tampered)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(tampered, anchor)
    assert all(card["repertoire_id"] != black.id for card in bundle)
    # And a synced attempt on the foreign node never lands.
    written = service.sync_progress(
        session.id, [{"node_id": foreign_node.id, "correct": True}]
    )
    assert written == 0
    assert repository.load_training_progress(black.id, foreign_node.id) is None
