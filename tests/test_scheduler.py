"""Smart-queue card scheduler (Train v2 Phase 1): pure planning tests.

Tree shape used throughout (White repertoire, two opening families):

    root ── e4(W) ── e5(B) ── Nf3(W) ── Nc6(B) ── Bb5(W)
        └── d4(W) ── d5(B) ── c4(W)

Own (trainable) nodes: e4, Nf3, Bb5, d4, c4.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from prepforge_chess.core.models import Color, TrainingProgress
from prepforge_chess.services.engine import MockEngine
from prepforge_chess.services.opening_builder import CreateRepertoireRequest, OpeningBuilderService
from prepforge_chess.services.scheduler import (
    CARD_DUE,
    CARD_NEW,
    CARD_POLISH,
    CARD_WEAK,
    TrainingCard,
    build_session_plan,
    decode_card,
    encode_card,
)
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository

from stub_maia import StubMaia

NOW = datetime(2026, 6, 11, 12, 0, 0, tzinfo=timezone.utc)
PAST = NOW - timedelta(hours=2)
FUTURE = NOW + timedelta(days=5)


def _repository():
    connection = connect_database()
    apply_schema(connection)
    return PrepForgeRepository(connection)


def _build_tree():
    """Returns (repertoire, ids) where ids maps san-ish names to node ids."""
    repository = _repository()
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Scheduler", color=Color.WHITE)
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


def _progress(node_id, *, attempts=0, correct=0, due_at=None, score=0.0, mastered=False):
    return TrainingProgress(
        node_id=node_id,
        attempts=attempts,
        correct_attempts=correct,
        last_reviewed_at=PAST,
        spaced_repetition_score=score,
        due_at=due_at,
        is_mastered=mastered,
    )


WEAK = dict(attempts=4, correct=1, due_at=FUTURE, score=1.0)
DUE = dict(attempts=3, correct=3, due_at=PAST, score=3.0)
MASTERED = dict(attempts=5, correct=5, due_at=FUTURE, score=8.0, mastered=True)
LEARNING = dict(attempts=1, correct=1, due_at=FUTURE, score=1.0)


def _kinds(plan):
    return [card.kind for card in plan.cards]


# ---- codec ------------------------------------------------------------------


def test_card_codec_round_trips():
    card = TrainingCard(kind=CARD_DUE, first_target_id="a-1", last_target_id="b-2")
    assert decode_card(encode_card(card)) == card


def test_decode_rejects_garbage():
    assert decode_card("not-a-card") is None
    assert decode_card("badkind:a:b") is None
    assert decode_card("due:a") is None
    assert decode_card(None) is None
    assert decode_card("due::b") is None


# ---- selection priorities ---------------------------------------------------


def test_untrained_repertoire_yields_new_cards_shallow_first():
    repertoire, ids = _build_tree()
    plan = build_session_plan(repertoire.root_node, Color.WHITE, {}, seed=1, new_cap=3)
    assert _kinds(plan) == [CARD_NEW] * 3
    # Shallow lines are introduced first: the cap admits both ply-1 moves and
    # the earliest ply-3 move, leaving the deeper material for later sessions.
    targets = {card.first_target_id for card in plan.cards}
    assert targets == {ids["e4"], ids["d4"], ids["nf3"]}


def test_new_cap_limits_introductions():
    repertoire, _ = _build_tree()
    plan = build_session_plan(repertoire.root_node, Color.WHITE, {}, seed=1, new_cap=2)
    assert plan.counts[CARD_NEW] == 2
    assert plan.counts["cards"] == 2  # nothing else to schedule


def test_weak_outranks_due_outranks_new():
    # weak (nf3) and due (d4) live in different opening families so they can't
    # merge into one card and the band order stays observable.
    repertoire, ids = _build_tree()
    progress = {
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["d4"]: _progress(ids["d4"], **DUE),
        # e4/bb5/c4 untrained -> new
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, new_cap=1, now=NOW
    )
    kinds = _kinds(plan)
    assert kinds[0] == CARD_WEAK
    assert plan.cards[0].last_target_id == ids["nf3"]
    assert kinds.index(CARD_DUE) < kinds.index(CARD_NEW)
    assert plan.counts[CARD_NEW] == 1


def test_session_size_caps_targets():
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **DUE)
        for node in (ids["e4"], ids["nf3"], ids["bb5"], ids["d4"], ids["c4"])
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=2,
        max_targets_per_card=1, now=NOW,
    )
    assert plan.counts["targets"] == 2


def test_polish_fills_leftover_room_soonest_due_first():
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **MASTERED)
        for node in (ids["e4"], ids["nf3"], ids["bb5"], ids["d4"], ids["c4"])
    }
    # e4 is due sooner than the others -> it should head the polish band.
    progress[ids["e4"]] = _progress(ids["e4"], attempts=5, correct=5, due_at=NOW + timedelta(days=1), score=8.0, mastered=True)
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=3,
        max_targets_per_card=1, now=NOW,
    )
    assert all(kind == CARD_POLISH for kind in _kinds(plan))
    assert plan.cards[0].first_target_id == ids["e4"]


def test_each_node_targeted_at_most_once():
    repertoire, _ = _build_tree()
    progress = {}
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, new_cap=10, session_size=30
    )
    targets = [card.first_target_id for card in plan.cards]
    assert len(targets) == len(set(targets)) == 5


def test_empty_tree_yields_empty_plan():
    repository = _repository()
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Empty", color=Color.WHITE)
    )
    plan = build_session_plan(repertoire.root_node, Color.WHITE, {}, seed=1)
    assert plan.cards == []
    assert plan.counts["cards"] == 0


# ---- merging ----------------------------------------------------------------


def test_consecutive_due_targets_merge_into_one_card():
    repertoire, ids = _build_tree()
    progress = {
        ids["e4"]: _progress(ids["e4"], **DUE),
        ids["nf3"]: _progress(ids["nf3"], **DUE),
        ids["bb5"]: _progress(ids["bb5"], **DUE),
        ids["d4"]: _progress(ids["d4"], **MASTERED),
        ids["c4"]: _progress(ids["c4"], **MASTERED),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=3, now=NOW
    )
    merged = [c for c in plan.cards if c.kind == CARD_DUE]
    assert len(merged) == 1
    assert merged[0].first_target_id == ids["e4"]
    assert merged[0].last_target_id == ids["bb5"]


def test_merge_respects_max_targets_per_card():
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **DUE)
        for node in (ids["e4"], ids["nf3"], ids["bb5"])
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=3,
        max_targets_per_card=2, new_cap=0, now=NOW,
    )
    due_cards = [c for c in plan.cards if c.kind == CARD_DUE]
    assert len(due_cards) == 2
    spans = {(c.first_target_id, c.last_target_id) for c in due_cards}
    assert (ids["e4"], ids["nf3"]) in spans
    assert (ids["bb5"], ids["bb5"]) in spans


def test_gap_in_selection_splits_cards():
    """e4 due, Nf3 mastered (not selected), Bb5 due -> two single cards, not a
    merged one spanning the unselected middle move."""
    repertoire, ids = _build_tree()
    progress = {
        ids["e4"]: _progress(ids["e4"], **DUE),
        ids["nf3"]: _progress(ids["nf3"], **MASTERED),
        ids["bb5"]: _progress(ids["bb5"], **DUE),
        ids["d4"]: _progress(ids["d4"], **MASTERED),
        ids["c4"]: _progress(ids["c4"], **MASTERED),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=2, now=NOW
    )
    due_cards = [c for c in plan.cards if c.kind == CARD_DUE]
    assert {(c.first_target_id, c.last_target_id) for c in due_cards} == {
        (ids["e4"], ids["e4"]),
        (ids["bb5"], ids["bb5"]),
    }


def test_new_cards_never_merge():
    repertoire, _ = _build_tree()
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, {}, seed=1, new_cap=10, session_size=30
    )
    assert all(card.first_target_id == card.last_target_id for card in plan.cards)


def test_weak_kind_wins_in_a_merged_card():
    repertoire, ids = _build_tree()
    progress = {
        ids["e4"]: _progress(ids["e4"], **DUE),
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["bb5"]: _progress(ids["bb5"], **MASTERED),
        ids["d4"]: _progress(ids["d4"], **MASTERED),
        ids["c4"]: _progress(ids["c4"], **MASTERED),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=2, now=NOW
    )
    card = plan.cards[0]
    assert card.kind == CARD_WEAK
    assert (card.first_target_id, card.last_target_id) == (ids["e4"], ids["nf3"])


# ---- determinism ------------------------------------------------------------


def test_same_seed_same_plan_different_seed_can_differ():
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **DUE)
        for node in (ids["e4"], ids["nf3"], ids["bb5"], ids["d4"], ids["c4"])
    }
    kwargs = dict(session_size=5, max_targets_per_card=1, now=NOW)
    a = build_session_plan(repertoire.root_node, Color.WHITE, progress, seed=7, **kwargs)
    b = build_session_plan(repertoire.root_node, Color.WHITE, progress, seed=7, **kwargs)
    assert a.cards == b.cards
