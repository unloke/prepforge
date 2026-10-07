"""SmartTrainingService (Train v2 Phase 1): card session flow over a live repo.

Covers the contracts that distinguish the smart trainer from the legacy one:
run-in context instead of replaying lines from move 1, first-attempt-only
spaced-repetition grading, in-session re-queue after a second wrong attempt,
multi-target cards, resume/rebuild, and stale-card skipping.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from prepforge_chess.core.models import Color, TrainingMode, TrainingProgress
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.scheduler import CARD_DUE, decode_card
from prepforge_chess.services.training_smart import REQUEUE_GAP, SmartTrainingService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


# start_or_resume schedules against the real clock, so due/mastered fixtures
# must be relative to it — a hardcoded date silently flips category.
NOW = datetime.now(timezone.utc)
PAST = NOW - timedelta(hours=2)


def _repository():
    connection = connect_database()
    apply_schema(connection)
    return WorkspaceRepository(connection)


def _build(repository):
    """White repertoire: e4 e5 Nf3 Nc6 Bb5 main line plus a d4 d5 c4 sideline."""
    builder = OpeningBuilderService(repository)
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


def _seed_progress(repository, repertoire_id, rows, owner="t-owner"):
    for row in rows:
        repository.save_training_progress(repertoire_id, row, owner_user_id=owner)


# ---- start / resume ---------------------------------------------------------


def test_start_builds_card_session():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository, "t-owner")
    session = service.start_or_resume(repertoire.id, seed=5)
    assert session.mode is TrainingMode.SMART
    assert session.line_order
    assert all(decode_card(raw) is not None for raw in session.line_order)
    counts = service.counts(session)
    assert counts["cards"] == len(session.line_order)


def test_start_resumes_unfinished_session():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository, "t-owner")
    first = service.start_or_resume(repertoire.id, seed=5)
    again = service.start_or_resume(repertoire.id, seed=99)
    assert again.id == first.id
    assert again.line_order == first.line_order


def test_fresh_rebuilds_queue():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository, "t-owner")
    first = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(first.id)
    service.submit_move(first.id, prompt.expected_move_uci)  # make some progress
    rebuilt = service.start_or_resume(repertoire.id, fresh=True, seed=6)
    assert rebuilt.id == first.id  # same row, rebuilt content
    assert rebuilt.current_index == 0
    assert rebuilt.seed == 6


def test_restart_counts_a_partially_played_first_card():
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(repository, repertoire.id, [_due(ids["e4"]), _due(ids["nf3"])]
                   + [_mastered(ids[k]) for k in ("bb5", "d4", "c4")])
    service = SmartTrainingService(repository, "t-owner")
    first = service.start_or_resume(repertoire.id, seed=5, session_size=2)
    prompt = service.current_prompt(first.id)
    service.submit_move(first.id, prompt.expected_move_uci)
    played = repository.load_training_session(first.id)
    assert played.current_index == 0 and played.current_node_id
    service.start_or_resume(repertoire.id, fresh=True, seed=6)
    assert repository.get_user_setting("t-owner", "recap.replaced_sessions") == 1


def test_restart_count_rolls_back_when_session_write_fails(monkeypatch):
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository, "t-owner")
    first = service.start_or_resume(repertoire.id, seed=5)
    service.submit_move(first.id, "a2a3")
    def fail(*args, **kwargs):
        raise RuntimeError("session write failed")
    monkeypatch.setattr(repository, "write_training_session", fail)
    with pytest.raises(RuntimeError, match="session write failed"):
        service.start_or_resume(repertoire.id, fresh=True)
    assert repository.get_user_setting("t-owner", "recap.replaced_sessions", 0) == 0


def test_deleted_review_archive_and_nodes_commit_together(monkeypatch):
    repository = _repository()
    repertoire, ids = _build(repository)
    _seed_progress(repository, repertoire.id, [_due(ids["bb5"])])
    def fail(*args, **kwargs):
        raise RuntimeError("archive write failed")
    monkeypatch.setattr(repository, "write_user_setting", fail)
    monkeypatch.setattr(repository, "mutate_user_setting", fail)
    with pytest.raises(RuntimeError, match="archive write failed"):
        repository.delete_opening_nodes(repertoire.id, [ids["bb5"]])
    assert ids["bb5"] in {n.id for n in repository._walk_nodes(repository.load_repertoire(repertoire.id).root_node)}


@pytest.mark.parametrize("excluded", ["disabled", "weak", "other-owner", "inactive"])
def test_dashboard_due_matches_trainable_personal_reviews(excluded):
    from prepforge_chess.api.routers.workspace import dashboard

    repository = _repository()
    repertoire, ids = _build(repository)
    repository.save_repertoire(repertoire, owner_user_id="t-owner")
    progress = _due(ids["bb5"])
    if excluded == "weak":
        progress.correct_attempts = 0
        progress.spaced_repetition_score = 0
    _seed_progress(repository, repertoire.id, [progress],
                   owner="other" if excluded == "other-owner" else "t-owner")
    if excluded == "disabled":
        repository.update_opening_nodes(repertoire.id, [{"id": ids["bb5"], "is_enabled": False}])
    if excluded == "inactive":
        repository.set_repertoire_active(repertoire.id, False)
    else:
        assert repository.due_counts_by_repertoire("t-owner").get(repertoire.id, 0) == 0
    assert dashboard(owner="t-owner", repo=repository)["due_reviews"] == 0


def test_dashboard_due_and_soon_partition_valid_review_times():
    from prepforge_chess.api.routers.workspace import dashboard

    repository = _repository()
    repertoire, ids = _build(repository)
    repository.save_repertoire(repertoire, owner_user_id="t-owner")
    now = _due(ids["e4"])
    soon = _due(ids["nf3"])
    later = _due(ids["bb5"])
    soon.due_at = datetime.now(timezone.utc) + timedelta(hours=12)
    later.due_at = datetime.now(timezone.utc) + timedelta(days=2)
    _seed_progress(repository, repertoire.id, [now, soon, later])
    data = dashboard(owner="t-owner", repo=repository)
    assert data["due_reviews"] == 1
    assert data["due_soon"] == 1


def test_start_raises_when_nothing_trainable():
    repository = _repository()
    builder = OpeningBuilderService(repository)
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Empty", color=Color.WHITE)
    )
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
    session = service.start_or_resume(repertoire.id, seed=5)
    prompt = service.current_prompt(session.id)
    assert prompt.expected_move_uci == "e2e4"
    assert prompt.run_in == []
    assert prompt.start_fen == prompt.fen_before


# ---- grading ----------------------------------------------------------------


def test_correct_first_attempt_writes_progress_and_advances():
    repository = _repository()
    repertoire, _ = _build(repository)
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    stored = repository.load_training_progress(repertoire.id, prompt.expected_node_id, owner_user_id="t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
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
    service = SmartTrainingService(repository, "t-owner")
    # session_size=2 -> exactly the two due targets, one card each (they sit
    # on different paths, so no merge and no polish fill).
    session = service.start_or_resume(repertoire.id, seed=5, session_size=2)
    assert len(session.line_order) == 2
    # Build deletes the first card's target out from under the session.
    first_card = decode_card(session.line_order[0])
    repository.delete_opening_nodes(repertoire.id, [first_card.last_target_id])
    # The Build edit and the resumed read are separate HTTP requests in
    # production, each with its own service (a service caches the repertoire tree
    # for one request's lifetime). A fresh service reads the post-edit tree and
    # skips the now-missing card.
    prompt = SmartTrainingService(repository, "t-owner").current_prompt(session.id)
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
    service = SmartTrainingService(repository, "t-owner")
    session = service.start_or_resume(repertoire.id, seed=5, session_size=1)
    assert len(session.line_order) == 1
    result = service.submit_move(session.id, "e2e4", attempt=1)
    assert result.session_completed is True
    assert result.next_prompt is None
    assert service.current_prompt(session.id) is None


# ---- mixed sessions (one queue over all active repertoires) -----------------


def _build_black(repository, owner=None):
    """Black repertoire: 1.e4 e5 2.Nf3 Nc6 (own moves e5, Nc6)."""
    builder = OpeningBuilderService(repository)
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
    for rep in repertoires:
        repository.claim_repertoire(rep.id, owner)


def test_mixed_session_spans_repertoires_in_chunks():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    owner = "owner-1"
    _claim(repository, owner, white, black)
    service = SmartTrainingService(repository, owner)
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
    service = SmartTrainingService(repository, owner)
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
    service = SmartTrainingService(repository, owner)
    session = service.start_or_resume_mixed(owner, seed=5)
    assert session.repertoire_id == white.id
    cards = [decode_card(raw) for raw in session.line_order]
    assert all(card is not None and card.repertoire_id == white.id for card in cards)


def test_mixed_sync_routes_progress_to_each_repertoire():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    owner = "owner-4"
    _claim(repository, owner, white, black)
    service = SmartTrainingService(repository, owner)
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
        [
            {"node_id": node_id, "correct": True, "attempt_uuid": "mix-{0}".format(rep_id)}
            for rep_id, node_id in picks.items()
        ],
        owner_user_id=owner,
    )
    assert written == 2
    for rep_id, node_id in picks.items():
        progress = repository.load_training_progress(rep_id, node_id, owner_user_id=owner)
        assert progress is not None and progress.attempts == 1
        other = black.id if rep_id == white.id else white.id
        assert repository.load_training_progress(other, node_id, owner_user_id=owner) is None
    # Retrying the same UUIDs is a no-op.
    written = service.sync_progress(
        session.id,
        [
            {"node_id": node_id, "correct": True, "attempt_uuid": "mix-{0}".format(rep_id)}
            for rep_id, node_id in picks.items()
        ],
        owner_user_id=owner,
    )
    assert written == 0


def test_mixed_sync_rejects_uuid_collision():
    repository = _repository()
    white, _ = _build(repository)
    owner = "owner-4b"
    _claim(repository, owner, white)
    service = SmartTrainingService(repository, owner)
    session = service.start_or_resume(white.id, seed=5)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(session, anchor)
    node_id = bundle[0]["targets"][0]["node_id"]
    written = service.sync_progress(
        session.id,
        [{"node_id": node_id, "correct": True, "attempt_uuid": "collide-1"}],
        owner_user_id=owner,
    )
    assert written == 1
    import pytest as _pytest

    with _pytest.raises(ValueError, match="different payload"):
        service.sync_progress(
            session.id,
            [{"node_id": node_id, "correct": False, "attempt_uuid": "collide-1"}],
            owner_user_id=owner,
        )


def test_sync_requires_uuid():
    import pytest as _pytest

    repository = _repository()
    white, _ = _build(repository)
    owner = "owner-4c"
    _claim(repository, owner, white)
    service = SmartTrainingService(repository, owner)
    session = service.start_or_resume(white.id, seed=5)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(session, anchor)
    node_id = bundle[0]["targets"][0]["node_id"]
    with _pytest.raises(ValueError, match="attempt_uuid"):
        service.sync_progress(
            session.id,
            [{"node_id": node_id, "correct": True}],
            owner_user_id=owner,
        )


def test_mixed_ignores_foreign_repertoire_cards():
    repository = _repository()
    white, _ = _build(repository)
    black = _build_black(repository)
    _claim(repository, "owner-5", white)
    _claim(repository, "owner-6", black)  # belongs to someone else
    service = SmartTrainingService(repository, "owner-5")
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
        session.id,
        [{"node_id": foreign_node.id, "correct": True, "attempt_uuid": "foreign-1"}],
        owner_user_id="owner-5",
    )
    assert written == 0
    assert (
        repository.load_training_progress(black.id, foreign_node.id, owner_user_id="owner-6")
        is None
    )


def test_postgres_concurrent_attempt_receipt():
    """A real PostgreSQL insert conflict must serialize identical retries."""
    import os
    import uuid
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import pytest
    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "train_retry_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = WorkspaceRepository(engine)
        repertoire, node_ids = _build(repo)
        owner = "postgres-concurrent-owner"
        _claim(repo, owner, repertoire)
        service = SmartTrainingService(repo, owner)
        session = service.start_or_resume(repertoire.id, seed=5)
        node_id = node_ids["e4"]
        attempt = {"node_id": node_id, "correct": True, "attempt_uuid": uuid.uuid4().hex}
        barrier = Barrier(2)

        def submit(payload):
            barrier.wait(timeout=10)
            return SmartTrainingService(WorkspaceRepository(engine), owner).sync_progress(
                session.id, [payload], owner_user_id=owner
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(submit, attempt)
            second = pool.submit(submit, attempt)
            results = sorted([first.result(timeout=30), second.result(timeout=30)])
            assert results == [0, 1], (
                results,
                repo.get_attempt_receipt(session.id, attempt["attempt_uuid"]),
                repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner),
                [node.id for node in repo.load_repertoire(repertoire.id).root_node.children],
            )
        progress = repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
        assert progress is not None and progress.attempts == 1
        with pytest.raises(ValueError, match="different payload"):
            service.sync_progress(session.id, [{**attempt, "correct": False}], owner_user_id=owner)
        assert repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner).attempts == 1
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()


def test_sync_read_modify_write_happens_inside_the_transaction(monkeypatch):
    """Structural guard for the smart-sync lost update fix.

    The progress row must be read-modify-written INSIDE the attempt's transaction
    under a row lock — never snapshotted before it. A pre-transaction snapshot is
    exactly the bug: a concurrent attempt (different attempt_uuid, same node)
    committing in that window was overwritten by values computed from the stale
    snapshot. The real interleaving runs on PostgreSQL in
    ``test_postgres_concurrent_sync_different_uuids_do_not_lose_updates``; this
    test pins the transactional read-modify-write shape deterministically."""
    repository = _repository()
    white, _ = _build(repository)
    owner = "owner-lost-update"
    _claim(repository, owner, white)
    service = SmartTrainingService(repository, owner)
    session = service.start_or_resume(white.id, seed=5)
    anchor = repository.load_repertoire(session.repertoire_id)
    bundle = service.session_card_bundle(session, anchor)
    node_id = bundle[0]["targets"][0]["node_id"]

    def fail_snapshot(self, repertoire_id, target_node_id, *, owner_user_id):
        raise AssertionError(
            "sync must not snapshot training progress outside its transaction"
        )

    original_lock = WorkspaceRepository.lock_training_progress
    locked = {"inside": False}

    def tracking_lock(self, conn, **kwargs):
        assert conn.in_transaction(), "locked read must run inside the attempt transaction"
        locked["inside"] = True
        return original_lock(self, conn, **kwargs)

    monkeypatch.setattr(WorkspaceRepository, "load_training_progress", fail_snapshot)
    monkeypatch.setattr(WorkspaceRepository, "lock_training_progress", tracking_lock)
    written = service.sync_progress(
        session.id,
        [{"node_id": node_id, "correct": True, "attempt_uuid": "slow-uuid"}],
        owner_user_id=owner,
    )
    assert written == 1
    assert locked["inside"]

    monkeypatch.undo()
    progress = repository.load_training_progress(white.id, node_id, owner_user_id=owner)
    assert progress is not None
    assert progress.attempts == 1
    assert progress.correct_attempts == 1


def test_postgres_interleaved_attempts_never_lose_an_update():
    """Deterministic interleaving on real PostgreSQL: a second attempt committing
    between the first attempt's progress read and its write must not be lost.

    The seam replays exactly that window — the racing attempt commits two
    attempts fully, then this attempt proceeds. The fixed flow reads the progress
    row locked INSIDE its transaction (after the racing commit), so all three
    attempts accumulate; the legacy snapshot-then-write flow overwrote the racing
    attempts with values computed from its stale snapshot."""
    import os
    import uuid

    import pytest
    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "train_interleave_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = WorkspaceRepository(engine)
        repertoire, node_ids = _build(repo)
        owner = "postgres-interleave-owner"
        _claim(repo, owner, repertoire)
        service = SmartTrainingService(repo, owner)
        session = service.start_or_resume(repertoire.id, seed=5)
        node_id = node_ids["e4"]

        raced = {"done": False}
        original_load = WorkspaceRepository.load_training_progress
        original_lock = WorkspaceRepository.lock_training_session

        def racing_attempts():
            raced["done"] = True
            return SmartTrainingService(WorkspaceRepository(engine), owner).sync_progress(
                session.id,
                [
                    {"node_id": node_id, "correct": True, "attempt_uuid": "racer-pg-1"},
                    {"node_id": node_id, "correct": True, "attempt_uuid": "racer-pg-2"},
                ],
                owner_user_id=owner,
            )

        def snapshot_then_race(self, repertoire_id, target_node_id, *, owner_user_id):
            # Legacy seam: snapshot taken, racing attempts commit, caller proceeds
            # on the stale snapshot and blind-overwrites the racing update.
            value = original_load(
                self, repertoire_id, target_node_id, owner_user_id=owner_user_id
            )
            if not raced["done"]:
                racing_attempts()
            return value

        def race_then_lock(self, conn, **kwargs):
            # Race before the batch takes its first session lock. A racing
            # sync inside the progress lock would now correctly block on this
            # batch, making synchronous test injection deadlock.
            if not raced["done"]:
                racing_attempts()
            return original_lock(self, conn, **kwargs)

        monkeypatch = pytest.MonkeyPatch()
        try:
            monkeypatch.setattr(
                WorkspaceRepository, "load_training_progress", snapshot_then_race
            )
            monkeypatch.setattr(WorkspaceRepository, "lock_training_session", race_then_lock)
            written = service.sync_progress(
                session.id,
                [{"node_id": node_id, "correct": True, "attempt_uuid": "slow-pg"}],
                owner_user_id=owner,
            )
        finally:
            monkeypatch.undo()
        assert written == 1
        progress = repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
        assert progress is not None
        assert progress.attempts == 3  # 2 racing + 1 slow — no lost update
        assert progress.correct_attempts == 3
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()


def test_postgres_concurrent_sync_different_uuids_do_not_lose_updates():
    """Real PostgreSQL: racing attempts with different UUIDs on the same node must
    ALL land — a row-locked read-modify-write, no lost update.

    Six racers on purpose: the fixed code is deterministic-green (the row lock
    serialises the read-modify-write), while a snapshot-then-write regression
    loses updates under this much parallelism with near certainty."""
    import os
    import uuid
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import pytest
    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "train_lost_upd_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = WorkspaceRepository(engine)
        repertoire, node_ids = _build(repo)
        owner = "postgres-lost-update-owner"
        _claim(repo, owner, repertoire)
        service = SmartTrainingService(repo, owner)
        session = service.start_or_resume(repertoire.id, seed=5)
        node_id = node_ids["e4"]
        racers = 6
        attempts = [
            {
                "node_id": node_id,
                "correct": index % 2 == 0,
                "attempt_uuid": uuid.uuid4().hex,
            }
            for index in range(racers)
        ]
        barrier = Barrier(racers)

        def submit(payload):
            barrier.wait(timeout=10)
            return SmartTrainingService(WorkspaceRepository(engine), owner).sync_progress(
                session.id, [payload], owner_user_id=owner
            )

        with ThreadPoolExecutor(max_workers=racers) as pool:
            futures = [pool.submit(submit, payload) for payload in attempts]
            results = [future.result(timeout=60) for future in futures]
        assert results == [1] * racers, (
            results,
            repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner),
        )
        progress = repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
        assert progress is not None
        assert progress.attempts == racers  # every attempt landed — no lost update
        assert progress.correct_attempts == racers // 2
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()


def test_sync_persists_the_session_without_a_blind_row_save(monkeypatch):
    """Structural guard for the smart-sync session clobber fix.

    ``sync_progress`` must persist session state transactionally — a locked
    read-modify-write committed together with the attempt — never via a blind
    ``save_training_session`` of an in-memory snapshot. That whole-row save is
    exactly the bug: a concurrent sync's session update (mistakes, mastered
    nodes, position) committed in between was overwritten wholesale. The real
    interleaving runs on PostgreSQL in
    ``test_postgres_interleaved_session_updates_never_lose_one``; this pins the
    shape deterministically on SQLite."""
    repository = _repository()
    white, ids = _build(repository)
    owner = "owner-session-clobber"
    _claim(repository, owner, white)
    service = SmartTrainingService(repository, owner)
    session = service.start_or_resume(white.id, seed=5)
    node_id = ids["e4"]
    first_card = session.line_order[0]

    def fail_blind_save(self, target):
        raise AssertionError(
            "sync must not save the session outside its own transactions"
        )

    monkeypatch.setattr(WorkspaceRepository, "save_training_session", fail_blind_save)
    written = service.sync_progress(
        session.id,
        [{"node_id": node_id, "correct": False, "attempt_uuid": "sess-1"}],
        card_index=0,
        state_version=session.state_version,
        queue=[first_card, "garbage-not-a-card"],
        owner_user_id=owner,
    )
    assert written == 1
    monkeypatch.undo()

    stored = repository.load_training_session(session.id)
    assert stored is not None
    assert node_id in stored.mistakes
    assert stored.line_order == [first_card]  # malformed queue entries dropped
    assert stored.current_index == 0
    assert stored.current_node_id is None


def test_postgres_interleaved_session_updates_never_lose_one():
    """Deterministic interleaving on real PostgreSQL: a second sync committing
    between the first sync's session snapshot and its session write must not
    clobber session state.

    The seam replays exactly that window — the racing sync commits two attempts
    fully (one wrong on another node, one correct on the slow attempt's node),
    then the slow attempt proceeds. The fixed flow rereads the session row
    locked INSIDE its transaction (after the racing commit) and merges, so both
    attempts land in progress AND both session updates survive; the legacy
    snapshot-then-upsert flow overwrote the racing sync's session state with
    values computed from its stale snapshot."""
    import os
    import uuid

    import pytest
    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "train_sess_il_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = WorkspaceRepository(engine)
        repertoire, node_ids = _build(repo)
        owner = "postgres-session-interleave-owner"
        _claim(repo, owner, repertoire)
        service = SmartTrainingService(repo, owner)
        session = service.start_or_resume(repertoire.id, seed=5)
        node_x = node_ids["e4"]
        node_y = node_ids["d4"]

        raced = {"done": False}
        original_lock = WorkspaceRepository.lock_training_session

        def racing_sync():
            raced["done"] = True
            return SmartTrainingService(WorkspaceRepository(engine), owner).sync_progress(
                session.id,
                [
                    {"node_id": node_x, "correct": True, "attempt_uuid": "racer-sess-1"},
                    {"node_id": node_y, "correct": False, "attempt_uuid": "racer-sess-2"},
                ],
                owner_user_id=owner,
            )

        def race_then_lock(self, conn, **kwargs):
            # The racing sync commits in the window between this call's session
            # snapshot and its session write — the exact legacy clobber window.
            if not raced["done"]:
                racing_sync()
            return original_lock(self, conn, **kwargs)

        monkeypatch = pytest.MonkeyPatch()
        try:
            monkeypatch.setattr(WorkspaceRepository, "lock_training_session", race_then_lock)
            written = service.sync_progress(
                session.id,
                [{"node_id": node_x, "correct": False, "attempt_uuid": "slow-sess"}],
                owner_user_id=owner,
            )
        finally:
            monkeypatch.undo()
        assert written == 1

        # Progress keeps BOTH updates (racing + slow) on the shared node.
        progress_x = repo.load_training_progress(repertoire.id, node_x, owner_user_id=owner)
        assert progress_x is not None
        assert progress_x.attempts == 2
        assert progress_x.correct_attempts == 1
        progress_y = repo.load_training_progress(repertoire.id, node_y, owner_user_id=owner)
        assert progress_y is not None and progress_y.attempts == 1

        # And the session keeps BOTH mistakes — the racing one not clobbered.
        stored = repo.load_training_session(session.id)
        assert stored is not None
        assert sorted(stored.mistakes) == sorted([node_x, node_y])
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()


def test_postgres_concurrent_sync_session_state_keeps_every_update():
    """Real PostgreSQL: racing syncs with different attempt UUIDs must ALL leave
    their session trace — a row-locked read-modify-write on the session row, no
    clobbered mistakes.

    Six racers on distinct nodes on purpose: the fixed code is
    deterministic-green (the session row lock serialises the merges), while a
    snapshot-then-upsert regression keeps only one writer's mistakes with near
    certainty under this much parallelism."""
    import os
    import uuid
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import pytest
    import sqlalchemy as sa
    from prepforge_chess.storage import sa_tables

    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL requires a real PostgreSQL server")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    schema = "train_sess_race_" + uuid.uuid4().hex[:16]
    admin = sa.create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
    engine = sa.create_engine(url, connect_args={"options": "-c search_path=" + schema})
    try:
        sa_tables.metadata.create_all(engine)
        repo = WorkspaceRepository(engine)
        repertoire, node_ids = _build(repo)
        owner = "postgres-session-race-owner"
        _claim(repo, owner, repertoire)
        service = SmartTrainingService(repo, owner)
        session = service.start_or_resume(repertoire.id, seed=5)
        race_nodes = [node_ids[key] for key in ("e4", "e5", "nf3", "nc6", "d4", "d5")]
        racers = len(race_nodes)
        attempts = [
            {"node_id": node_id, "correct": False, "attempt_uuid": uuid.uuid4().hex}
            for node_id in race_nodes
        ]
        barrier = Barrier(racers)

        def submit(payload):
            barrier.wait(timeout=10)
            return SmartTrainingService(WorkspaceRepository(engine), owner).sync_progress(
                session.id, [payload], owner_user_id=owner
            )

        with ThreadPoolExecutor(max_workers=racers) as pool:
            futures = [pool.submit(submit, payload) for payload in attempts]
            results = [future.result(timeout=60) for future in futures]
        assert results == [1] * racers

        # Every attempt's progress landed …
        for node_id in race_nodes:
            progress = repo.load_training_progress(repertoire.id, node_id, owner_user_id=owner)
            assert progress is not None and progress.attempts == 1, node_id
        # … and every attempt's session update survived — nothing clobbered.
        stored = repo.load_training_session(session.id)
        assert stored is not None
        assert sorted(stored.mistakes) == sorted(race_nodes)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
        admin.dispose()


def test_sync_batch_rolls_back_on_later_uuid_collision():
    repo = _repository()
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    session = service.start_or_resume(rep.id)
    service.sync_progress(session.id, [{"node_id": ids["e4"], "correct": True, "attempt_uuid": "taken"}], owner_user_id="t-owner")
    before = repo.load_training_session(session.id)
    with pytest.raises(ValueError, match="different payload"):
        service.sync_progress(session.id, [
            {"node_id": ids["d4"], "correct": False, "attempt_uuid": "new"},
            {"node_id": ids["e4"], "correct": False, "attempt_uuid": "taken"},
        ], owner_user_id="t-owner")
    assert repo.get_attempt_receipt(session.id, "new") is None
    assert repo.load_training_session(session.id) == before


def test_sync_old_generation_cannot_mutate_rebuilt_session():
    repo = _repository()
    rep, ids = _build(repo)
    service = SmartTrainingService(repo, "t-owner")
    old = service.start_or_resume(rep.id)
    rebuilt = service.start_or_resume(rep.id, fresh=True)
    assert old.id == rebuilt.id
    with pytest.raises(ValueError, match="generation"):
        service.sync_progress(old.id, [{"node_id": ids["e4"], "correct": False, "attempt_uuid": "late"}],
            card_index=999, queue=[], session_generation=old.created_at.isoformat(), owner_user_id="t-owner")
    assert repo.get_attempt_receipt(old.id, "late") is None
    assert repo.load_training_session(old.id) == rebuilt

def test_due_windows_equal_two_mastery_queries_in_one_statement():
    from sqlalchemy import event
    repository = _repository()
    repertoire, ids = _build(repository)
    repository.save_repertoire(repertoire, owner_user_id="t-owner")
    rows = [_due(ids[key]) for key in ["e4", "nf3", "bb5", "d4", "c4"]]
    rows[1].due_at = NOW + timedelta(hours=12)
    rows[2].due_at = NOW + timedelta(hours=30)
    rows[3].correct_attempts = 0  # weak takes priority over due
    rows[3].spaced_repetition_score = 0
    _seed_progress(repository, repertoire.id, rows)
    repository.update_opening_nodes(repertoire.id, [{"id": ids["d5"], "is_enabled": False}])
    expected_now = repository.due_counts_by_repertoire("t-owner", now=NOW)
    until = NOW + timedelta(hours=24)
    expected_until = repository.due_counts_by_repertoire("t-owner", now=until)
    statements = []
    def collect(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)
    event.listen(repository.engine, "before_cursor_execute", collect)
    try:
        actual = repository.due_windows_by_repertoire("t-owner", now=NOW, until=until)
    finally:
        event.remove(repository.engine, "before_cursor_execute", collect)
    assert actual == {rid: {"due": count, "due_until": expected_until[rid]} for rid, count in expected_now.items()}
    assert len(statements) == 1
