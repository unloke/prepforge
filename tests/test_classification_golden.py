"""Cross-end classification contract — the server half.

``tests/fixtures/classification_golden.json`` is shared with the browser suite
(``web-src/coach/classification-golden.test.js``). The two production
implementations stay independent — ``services/classification.py`` and
``web-src/coach/features.js`` — and this contract pins both to the same golden
semantics: tier behaviour at the 0/2/5/10/15 win-chance-loss boundaries, mate
and extreme evaluations, and the Brilliant-candidate 2% eligibility edge.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.classification import ClassificationConfig, classify_move

FIXTURE = Path(__file__).parent / "fixtures" / "classification_golden.json"
GOLDEN = json.loads(FIXTURE.read_text(encoding="utf-8"))
CASES = GOLDEN["cases"]

# services/brilliant.py gates Brilliant on the classifier's BEST/EXCELLENT — the
# server-side spelling of the browser's `isBest || winDelta <= 2` eligibility cap.
SERVER_BRILLIANT_ELIGIBLE = {MoveClassification.BEST, MoveClassification.EXCELLENT}


def _eval(spec: dict) -> EngineEvaluation:
    if spec.get("mate") is not None:
        return EngineEvaluation(engine="stockfish", mate_in=spec["mate"])
    return EngineEvaluation(engine="stockfish", score_cp=spec.get("cp"))


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_server_classification_matches_golden(case: dict) -> None:
    result = classify_move(
        side_to_move=Color(case["side_to_move"]),
        played_move_uci=case["played"]["uci"],
        best_move_uci=case["best"]["uci"],
        played_eval_after=_eval(case["played_eval_after"]),
        best_eval_after=_eval(case["best_eval_after"]),
    )
    expected = case["expected"]
    assert result.classification.value == expected["server"]
    if expected["loss_pct"] is not None:
        # Shared numeric contract: the same evals must yield the same mover-POV
        # win-chance loss on both ends (within rounding of the fixture value).
        assert abs(result.win_chance_loss * 100 - expected["loss_pct"]) < 0.05
    # Brilliant-candidate eligibility (2% edge) on the server side.
    assert (result.classification in SERVER_BRILLIANT_ELIGIBLE) == expected["brilliant_candidate"]


def test_golden_thresholds_match_server_config() -> None:
    """The fixture's boundary table must track ClassificationConfig exactly — a
    threshold tweak without a fixture update fails here instead of silently
    re-bucketing every golden case."""
    config = ClassificationConfig()
    assert GOLDEN["thresholds_pct"] == {
        "excellent_max_loss": round(config.excellent_loss * 100, 6),
        "good_max_loss": round(config.good_loss * 100, 6),
        "inaccuracy_max_loss": round(config.inaccuracy_loss * 100, 6),
        "mistake_max_loss": round(config.mistake_loss * 100, 6),
    }
    assert (
        GOLDEN["brilliant_candidate_max_win_delta_pct"]
        == round(config.excellent_loss * 100, 6)
    )


def test_golden_covers_every_boundary() -> None:
    """The contract promises cases at 0/2/5/10/15% with a case each side of
    every edge; assert the fixture still delivers that coverage."""
    losses = [
        case["expected"]["loss_pct"]
        for case in CASES
        if case["expected"]["loss_pct"] is not None
    ]
    for boundary in (2, 5, 10, 15):
        assert any(loss < boundary for loss in losses), boundary
        assert any(loss > boundary for loss in losses), boundary
    assert 0.0 in losses
