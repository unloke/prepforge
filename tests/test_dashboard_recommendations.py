"""Regression tests for the dashboard recommendation decision logic.

``build_recommendations`` is the single place that turns account state into the
ordered next actions on ``GET /api/dashboard``; these tests pin the converged
contract: only state-driven actions (due reviews, weak/unresolved-mistake
review) ever appear — generic navigation recommendations that duplicated the
top nav are gone.
"""
from __future__ import annotations

from prepforge_chess.services.dashboard_recommendations import (
    MAX_RECOMMENDATIONS,
    DashboardSignals,
    build_recommendations,
)

STATE_ACTION_IDS = {"train-due", "review-weak"}
VALID_VIEWS = {"train", "build", "analyze"}


def test_brand_new_account_gets_no_navigation_spam():
    assert build_recommendations(DashboardSignals()) == []


def test_due_reviews_win_first():
    signals = DashboardSignals(
        games=4,
        repertoires=2,
        training_sessions=6,
        due_reviews=5,
        open_mistakes=2,
        weak=1,
    )
    items = build_recommendations(signals)
    assert items[0]["id"] == "train-due"
    assert items[0]["cta"] == {"label": "Start due review", "view": "train"}
    assert "5 review cards due now" == items[0]["title"]
    assert [item["id"] for item in items] == ["train-due", "review-weak"]


def test_weak_and_mistakes_get_targeted_review():
    signals = DashboardSignals(games=4, repertoires=1, training_sessions=3, weak=2, open_mistakes=1)
    items = build_recommendations(signals)
    assert [item["id"] for item in items] == ["review-weak"]
    assert items[0]["cta"]["view"] == "train"
    assert "2 weak moves" in items[0]["detail"]
    assert "1 unresolved mistake" in items[0]["detail"]


def test_weak_only_still_targets_review():
    items = build_recommendations(
        DashboardSignals(games=1, repertoires=1, training_sessions=1, weak=1)
    )
    assert items[0]["id"] == "review-weak"
    assert "1 weak move" in items[0]["detail"]
    assert "unresolved mistake" not in items[0]["detail"]


def test_open_mistakes_only_still_targets_review():
    items = build_recommendations(
        DashboardSignals(games=1, repertoires=1, training_sessions=1, open_mistakes=3)
    )
    assert items[0]["id"] == "review-weak"
    assert "3 unresolved mistakes" in items[0]["detail"]


def test_steady_state_without_work_emits_nothing():
    # Nothing due, nothing weak: the Today card keeps the account's numbers
    # (streak / queue) and stops there — no filler navigation steps.
    assert build_recommendations(
        DashboardSignals(games=5, repertoires=2, training_sessions=4)
    ) == []
    assert build_recommendations(DashboardSignals(games=3)) == []
    assert build_recommendations(DashboardSignals(games=0, training_sessions=2)) == []


def test_due_soon_alone_does_not_interrupt_steady_state():
    assert build_recommendations(
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_soon=3)
    ) == []


def test_no_generic_navigation_recommendations_in_any_state():
    """THE regression: recommendations like "Analyze a game → Open Analyze" /
    "Extend a repertoire branch → Open Build" duplicated the top navigation and
    crowded the Today card. They must never come back for any account state."""
    states = [
        DashboardSignals(),
        DashboardSignals(games=3),
        DashboardSignals(games=0, training_sessions=2),
        DashboardSignals(games=5, repertoires=2, training_sessions=4),
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_soon=3),
        DashboardSignals(
            games=3,
            repertoires=0,
            training_sessions=0,
            due_reviews=2,
            weak=2,
            open_mistakes=2,
        ),
    ]
    for signals in states:
        items = build_recommendations(signals)
        assert {item["id"] for item in items} <= STATE_ACTION_IDS, signals
        for item in items:
            assert item["title"] not in {
                "Analyze a game",
                "Extend a repertoire branch",
                "Create or import a repertoire",
                "Create or import your first repertoire",
                "Train your first cards",
            }


def test_details_carry_counts_not_prose():
    items = build_recommendations(
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_reviews=5, weak=2)
    )
    for item in items:
        # The detail is a compact count line (or empty) — never a paragraph.
        assert len(item["detail"]) <= 80
        assert "Spaced repetition has cards ready today" not in item["detail"]
        assert "fastest win" not in item["detail"]


def test_list_is_capped_at_max():
    signals = DashboardSignals(
        games=3, repertoires=0, training_sessions=0, due_reviews=2, weak=2, open_mistakes=2
    )
    items = build_recommendations(signals)
    assert 0 < len(items) <= MAX_RECOMMENDATIONS


def test_every_recommendation_carries_a_valid_cta():
    states = [
        DashboardSignals(due_reviews=1),
        DashboardSignals(weak=1),
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_reviews=1, weak=1),
    ]
    for signals in states:
        for item in build_recommendations(signals):
            assert item["id"]
            assert item["title"]
            assert item["detail"] is not None
            assert item["cta"]["label"]
            assert item["cta"]["view"] in VALID_VIEWS
