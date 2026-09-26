"""Regression tests for the dashboard recommendation decision logic.

``build_recommendations`` is the single place that turns account state into the
ordered next actions on ``GET /api/dashboard``; these tests pin the priority
rules across account states (due reviews first, targeted weak/mistake review,
repertoire guidance, brand-new onboarding).
"""
from __future__ import annotations

from prepforge_chess.services.dashboard_recommendations import (
    MAX_RECOMMENDATIONS,
    DashboardSignals,
    build_recommendations,
)

VALID_VIEWS = {"train", "build", "analyze"}



def test_brand_new_account_keeps_simple_onboarding():
    items = build_recommendations(DashboardSignals())
    assert [item["id"] for item in items] == [
        "onboarding-analyze",
        "onboarding-repertoire",
        "onboarding-train",
    ]
    # Each step has a CTA into the matching view.
    assert [item["cta"]["view"] for item in items] == ["analyze", "build", "train"]


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
    # The targeted review follows, then a generic steady-state step.
    assert [item["id"] for item in items] == ["train-due", "review-weak", "analyze-game"]


def test_weak_and_mistakes_get_targeted_review():
    signals = DashboardSignals(games=4, repertoires=1, training_sessions=3, weak=2, open_mistakes=1)
    items = build_recommendations(signals)
    assert [item["id"] for item in items] == ["review-weak", "analyze-game", "extend-repertoire"]
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


def test_no_repertoire_guides_create_or_import():
    # Games but no repertoire: the guide is create/import, not the onboarding trio.
    items = build_recommendations(DashboardSignals(games=3))
    assert [item["id"] for item in items] == ["create-repertoire"]
    assert items[0]["cta"] == {"label": "Open Build", "view": "build"}
    assert "import" in items[0]["detail"].lower()


def test_no_repertoire_with_sessions_still_guides_create_or_import():
    items = build_recommendations(DashboardSignals(games=0, training_sessions=2))
    assert [item["id"] for item in items] == ["create-repertoire"]


def test_steady_state_generic_next_steps():
    items = build_recommendations(
        DashboardSignals(games=5, repertoires=2, training_sessions=4)
    )
    assert [item["id"] for item in items] == ["analyze-game", "extend-repertoire"]
    assert [item["cta"]["view"] for item in items] == ["analyze", "build"]


def test_due_soon_alone_does_not_interrupt_steady_state():
    items = build_recommendations(
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_soon=3)
    )
    assert [item["id"] for item in items] == ["analyze-game", "extend-repertoire"]


def test_list_is_capped_at_max():
    signals = DashboardSignals(
        games=3, repertoires=0, training_sessions=0, due_reviews=2, weak=2, open_mistakes=2
    )
    items = build_recommendations(signals)
    assert 0 < len(items) <= MAX_RECOMMENDATIONS


def test_every_recommendation_carries_a_valid_cta():
    states = [
        DashboardSignals(),
        DashboardSignals(games=3),
        DashboardSignals(games=5, repertoires=2, training_sessions=4),
        DashboardSignals(games=5, repertoires=2, training_sessions=4, due_reviews=1, weak=1),
    ]
    for signals in states:
        for item in build_recommendations(signals):
            assert item["id"]
            assert item["title"]
            assert item["detail"]
            assert item["cta"]["label"]
            assert item["cta"]["view"] in VALID_VIEWS
