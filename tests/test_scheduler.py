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
    DEFAULT_NEW_CAP,
    WEAK_SHARE,
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


def _build_wide_tree():
    """A bigger three-family tree for the crowded-pool policy test: enough own
    (White trainable) nodes that weak, due, and new pools can ALL exceed their
    policy shares at the same time.

        root ── e4(W) ── e5(B) ── Nf3(W) ── Nc6(B) ── Bb5(W) ── a6(B) ── Ba4(W)
            └── d4(W) ── d5(B) ── c4(W)  ── dxc4(B) ── e3(W)  ── b5(B) ── a4(W)
            └── g3(W) ── g6(B) ── Bg2(W) ── Nf6(B) ── d3(W)  ── d6(B) ── Qd2(W)

    Own nodes: e4, Nf3, Bb5, Ba4 | d4, c4, e3, a4 | g3, Bg2, d3, Qd2 — 12 total.
    Every key the tests index is listed in ``ids``.
    """
    repository = _repository()
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Scheduler Wide", color=Color.WHITE)
    )

    def line(moves):
        node = None
        for i, (uci, prepared) in enumerate(moves):
            parent = repertoire.root_node.id if i == 0 else node.id
            node = builder.add_move(
                repertoire.id, parent, uci, is_user_prepared_move=prepared
            )
        return node

    # Family 1 (e4): prepared = white ply
    e4 = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4", is_user_prepared_move=True)
    e5 = builder.add_move(repertoire.id, e4.id, "e7e5")
    nf3 = builder.add_move(repertoire.id, e5.id, "g1f3", is_user_prepared_move=True)
    nc6 = builder.add_move(repertoire.id, nf3.id, "b8c6")
    bb5 = builder.add_move(repertoire.id, nc6.id, "f1b5", is_user_prepared_move=True)
    a6 = builder.add_move(repertoire.id, bb5.id, "a7a6")
    ba4 = builder.add_move(repertoire.id, a6.id, "b5a4", is_user_prepared_move=True)
    # Family 2 (d4)
    d4 = builder.add_move(repertoire.id, repertoire.root_node.id, "d2d4", is_user_prepared_move=True)
    d5 = builder.add_move(repertoire.id, d4.id, "d7d5")
    c4 = builder.add_move(repertoire.id, d5.id, "c2c4", is_user_prepared_move=True)
    dxc4 = builder.add_move(repertoire.id, c4.id, "d5c4")
    e3 = builder.add_move(repertoire.id, dxc4.id, "e2e3", is_user_prepared_move=True)
    b5 = builder.add_move(repertoire.id, e3.id, "b7b5")
    a4 = builder.add_move(repertoire.id, b5.id, "a2a4", is_user_prepared_move=True)
    # Family 3 (g3)
    g3 = builder.add_move(repertoire.id, repertoire.root_node.id, "g2g3", is_user_prepared_move=True)
    g6 = builder.add_move(repertoire.id, g3.id, "g7g6")
    bg2 = builder.add_move(repertoire.id, g6.id, "f1g2", is_user_prepared_move=True)
    nf6 = builder.add_move(repertoire.id, bg2.id, "g8f6")
    d3 = builder.add_move(repertoire.id, nf6.id, "d2d3", is_user_prepared_move=True)
    d6 = builder.add_move(repertoire.id, d3.id, "d7d6")
    qd2 = builder.add_move(repertoire.id, d6.id, "d1d2", is_user_prepared_move=True)

    ids = dict(
        e4=e4.id, nf3=nf3.id, bb5=bb5.id, ba4=ba4.id,
        d4=d4.id, c4=c4.id, e3=e3.id, a4=a4.id,
        g3=g3.id, bg2=bg2.id, d3=d3.id, qd2=qd2.id,
    )
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


def test_weak_pool_capped_so_due_and_new_reach_the_queue():
    """A pile of weak targets must not monopolise the session: weak takes at most
    its share up front, and due/new material fills the rest."""
    repertoire, ids = _build_tree()
    # All five own-move nodes weak; every other pool empty except two new nodes
    # (e4, d4 are weak here, so the new pool is empty) — build a second repertoire
    # shape instead: use due on two nodes to keep it single-tree. We mark nf3/bb5/c4
    # weak and e4/d4 due; weak count 3 exceeds the 60% share of session_size=3? No —
    # use session_size=5 with 4 weak and 1 due so the old policy (weak first, then
    # due) fills 4 weak + 1 due, while the capped policy admits at most ceil/int
    # share. With session_size=5 the share is int(5*0.6)=3 weak, then due (1),
    # then the remaining weak tops off (1) — same totals but the DUE card must be
    # present, and weak must not exceed the share before due is admitted.
    progress = {
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["bb5"]: _progress(ids["bb5"], **WEAK),
        ids["c4"]: _progress(ids["c4"], **WEAK),
        ids["e4"]: _progress(ids["e4"], **WEAK),
        ids["d4"]: _progress(ids["d4"], **DUE),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=5,
        max_targets_per_card=1, now=NOW,
    )
    assert plan.counts[CARD_DUE] == 1, "due must reach the queue alongside weak"
    weak_share = max(1, int(5 * WEAK_SHARE))
    assert plan.counts["targets"] == 5
    # Weak gets its share first, then due, then the leftover weak top-off.
    assert plan.counts[CARD_WEAK] == 4
    assert weak_share == 3


def test_weak_only_session_still_fills_with_weak():
    """When weak is the ONLY pool, the top-off must fill the whole session —
    the cap limits weak's priority, not the session's size."""
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **WEAK)
        for node in (ids["e4"], ids["nf3"], ids["bb5"], ids["d4"], ids["c4"])
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=4,
        max_targets_per_card=1, now=NOW,
    )
    assert plan.counts["targets"] == 4
    assert all(kind == CARD_WEAK for kind in _kinds(plan))


def test_new_cap_still_limits_introductions_with_weak_present():
    """The new_cap applies after weak's share; new introductions must respect it
    even when the weak pool already consumed its slot."""
    repertoire, ids = _build_tree()
    progress = {
        node: _progress(node, **WEAK)
        for node in (ids["nf3"], ids["bb5"], ids["c4"])
    }
    # e4, d4 remain untrained -> new; new_cap=1 keeps only one of them.
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=5,
        new_cap=1, max_targets_per_card=1, now=NOW,
    )
    assert plan.counts[CARD_NEW] == 1
    assert plan.counts[CARD_WEAK] == 3
    assert plan.counts["targets"] == 4


def test_session_fills_when_candidates_are_sufficient():
    """Enough spread candidates must fill the session exactly to session_size
    under the weak-share policy (weak share → due → new → polish → weak top-off)."""
    repertoire, ids = _build_tree()
    progress = {
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["bb5"]: _progress(ids["bb5"], **WEAK),
        ids["c4"]: _progress(ids["c4"], **WEAK),
        ids["e4"]: _progress(ids["e4"], **DUE),
        ids["d4"]: _progress(ids["d4"], **MASTERED),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=5,
        max_targets_per_card=1, now=NOW,
    )
    assert plan.counts["targets"] == 5
    kinds = _kinds(plan)
    assert kinds.count(CARD_WEAK) == 3
    assert kinds.count(CARD_DUE) == 1
    assert kinds.count(CARD_POLISH) == 1


def test_small_session_weak_share_never_drops_due():
    """session_size=2: the share is max(1, int(2*0.6))=1, so one weak + one due
    is admitted — weak cannot crowd due out even at tiny session sizes."""
    repertoire, ids = _build_tree()
    progress = {
        ids["e4"]: _progress(ids["e4"], **WEAK),
        ids["d4"]: _progress(ids["d4"], **DUE),
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=2,
        max_targets_per_card=1, now=NOW,
    )
    assert plan.counts[CARD_WEAK] == 1
    assert plan.counts[CARD_DUE] == 1


def test_crowded_weak_due_and_new_pools_split_the_session_by_share():
    """Regression for the 60% weak policy with EVERY pool crowded at once: six
    weak, three due, and three untrained nodes compete for a session of 8 with
    new_cap=2. The plan must be weak share (4) → due (3) → new (1, the one slot
    left, also under the cap) — never the old uncapped behaviour where weak-first
    greed would take all 6 weak and squeeze due to 2 and new to 0."""
    repertoire, ids = _build_wide_tree()
    progress = {
        # 6 weak
        ids["e4"]: _progress(ids["e4"], **WEAK),
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["bb5"]: _progress(ids["bb5"], **WEAK),
        ids["d4"]: _progress(ids["d4"], **WEAK),
        ids["c4"]: _progress(ids["c4"], **WEAK),
        ids["g3"]: _progress(ids["g3"], **WEAK),
        # 3 due
        ids["bg2"]: _progress(ids["bg2"], **DUE),
        ids["d3"]: _progress(ids["d3"], **DUE),
        ids["e3"]: _progress(ids["e3"], **DUE),
        # ba4, a4, qd2 untrained → new pool of 3
    }
    plan = build_session_plan(
        repertoire.root_node, Color.WHITE, progress, seed=1, session_size=8,
        new_cap=2, max_targets_per_card=1, now=NOW,
    )
    assert max(1, int(8 * WEAK_SHARE)) == 4
    assert plan.counts[CARD_WEAK] == 4, "weak must stop at its share"
    assert plan.counts[CARD_DUE] == 3, "all due reviews must be admitted after the share"
    assert plan.counts[CARD_NEW] == 1, "new takes the one remaining slot under new_cap"
    assert plan.counts["targets"] == 8


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


def test_branch_off_a_merging_path_splits_cards_at_the_fork():
    """Characterization: a SECOND own-move branch hanging off an ancestor whose
    first branch is already merging must start its own card, and the merge
    cursor (``draft_by_tail``) must keep working for BOTH subtrees afterwards.

    Tree (White repertoire):

        root ─ e4(W) ─ e5(B) ── Nf3(W) ── Nc6(B) ── Bb5(W)   [e4-Nf3-Bb5 all due]
               e4(W) ─ e5(B) ── Nf3(W) ── Nf6(B) ── Bc4(W)   [Bc4 due]

    Preorder visits e4, Nf3 (line 1), Bb5, Bc4. e4→Nf3 merge; Bb5 continues
    that card (tail Nf3); Bc4's prev_own_id is ALSO Nf3 — the tail lookup must
    still resolve to the (already advanced) e4-Nf3-Bb5 draft and Bc4, finding
    the tail moved, opens its own card. The invariant under test: no node is
    lost, no card spans across the fork, and every card's first/last targets
    are the preorder-contiguous spans of one path.
    """
    repository = _repository()
    builder = OpeningBuilderService(repository, engine=MockEngine(), maia=StubMaia())
    repertoire = builder.create_repertoire(
        CreateRepertoireRequest(name="Fork", color=Color.WHITE)
    )
    ids = {}
    e4 = builder.add_move(repertoire.id, repertoire.root_node.id, "e2e4", is_user_prepared_move=True)
    e5 = builder.add_move(repertoire.id, e4.id, "e7e5")
    nf3 = builder.add_move(repertoire.id, e5.id, "g1f3", is_user_prepared_move=True)
    nc6 = builder.add_move(repertoire.id, nf3.id, "b8c6")
    bb5 = builder.add_move(repertoire.id, nc6.id, "f1b5", is_user_prepared_move=True)
    nf6 = builder.add_move(repertoire.id, nf3.id, "g8f6")
    bc4 = builder.add_move(repertoire.id, nf6.id, "f1c4", is_user_prepared_move=True)
    ids.update(e4=e4.id, nf3=nf3.id, bb5=bb5.id, bc4=bc4.id)
    loaded = repository.load_repertoire(repertoire.id)
    assert loaded is not None

    progress = {
        node: _progress(node, **DUE)
        for node in (ids["e4"], ids["nf3"], ids["bb5"], ids["bc4"])
    }
    plan = build_session_plan(
        loaded.root_node, Color.WHITE, progress, seed=1, session_size=4,
        max_targets_per_card=3, now=NOW,
    )
    due_cards = [c for c in plan.cards if c.kind == CARD_DUE]
    spans = {(c.first_target_id, c.last_target_id) for c in due_cards}
    # Line 1 merges e4→Nf3→Bb5 (bounded by max_targets_per_card=3); the sibling
    # branch's Bc4 cannot join it and opens its own card.
    assert (ids["e4"], ids["bb5"]) in spans
    assert (ids["bc4"], ids["bc4"]) in spans
    assert len(due_cards) == 2
    # No target is lost: the merge card spans e4→Nf3→Bb5 (Nf3 is the interior
    # path node between the endpoints, not an endpoint itself) and Bc4 stands
    # alone, so 3 + 1 = 4 targets are scheduled in total.
    assert plan.counts["targets"] == 4


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


def test_weak_share_policy_keeps_seed_deterministic():
    """The weak-share selection must stay seed-deterministic: mixed weak/due/new
    pools, same seed twice → identical plans (cards are compared including order)."""
    repertoire, ids = _build_tree()
    progress = {
        ids["nf3"]: _progress(ids["nf3"], **WEAK),
        ids["bb5"]: _progress(ids["bb5"], **WEAK),
        ids["e4"]: _progress(ids["e4"], **DUE),
        ids["d4"]: _progress(ids["d4"], **DUE),
        # c4 untrained -> new
    }
    kwargs = dict(session_size=5, max_targets_per_card=1, new_cap=DEFAULT_NEW_CAP, now=NOW)
    a = build_session_plan(repertoire.root_node, Color.WHITE, progress, seed=42, **kwargs)
    b = build_session_plan(repertoire.root_node, Color.WHITE, progress, seed=42, **kwargs)
    assert a.cards == b.cards
    assert a.counts == b.counts
