import math

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.classification import (
    classify_move,
    cp_to_win_chance,
    evaluation_to_white_win_chance,
    win_chance_for_side,
)


def test_cp_to_win_chance_matches_formula():
    assert cp_to_win_chance(0) == 0.5
    expected = 1.0 / (1.0 + math.exp(-0.00368208 * 100))
    assert abs(cp_to_win_chance(100) - expected) < 1e-9


def test_cp_to_win_chance_clips_extremes():
    expected_high = 1.0 / (1.0 + math.exp(-0.00368208 * 1000))
    expected_low = 1.0 / (1.0 + math.exp(-0.00368208 * -1000))
    assert cp_to_win_chance(5000) == expected_high
    assert cp_to_win_chance(-5000) == expected_low


def test_mate_uses_clipped_extreme():
    mate_for_white = EngineEvaluation(engine="stockfish", mate_in=3)
    mate_for_black = EngineEvaluation(engine="stockfish", mate_in=-3)
    assert evaluation_to_white_win_chance(mate_for_white) == cp_to_win_chance(1000)
    assert evaluation_to_white_win_chance(mate_for_black) == cp_to_win_chance(-1000)


def test_win_chance_for_side_flips_for_black():
    evaluation = EngineEvaluation(engine="stockfish", score_cp=200)
    white_wc = win_chance_for_side(evaluation, Color.WHITE)
    black_wc = win_chance_for_side(evaluation, Color.BLACK)
    assert abs(white_wc + black_wc - 1.0) < 1e-9


def test_matching_first_choice_is_best():
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="e2e4",
        best_move_uci="e2e4",
        played_eval_after=EngineEvaluation(engine="stockfish", score_cp=32),
        best_eval_after=EngineEvaluation(engine="stockfish", score_cp=32),
    )
    assert result.classification is MoveClassification.BEST
    assert result.win_chance_loss == 0.0


def test_small_loss_is_excellent():
    best = EngineEvaluation(engine="stockfish", score_cp=50)
    played = EngineEvaluation(engine="stockfish", score_cp=40)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.EXCELLENT
    assert 0.0 < result.win_chance_loss <= 0.02


def test_moderate_loss_is_good():
    best = EngineEvaluation(engine="stockfish", score_cp=100)
    played = EngineEvaluation(engine="stockfish", score_cp=50)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.GOOD
    assert 0.02 < result.win_chance_loss <= 0.05


def test_inaccuracy_loss_band():
    best = EngineEvaluation(engine="stockfish", score_cp=200)
    played = EngineEvaluation(engine="stockfish", score_cp=100)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.INACCURACY
    assert 0.05 < result.win_chance_loss <= 0.10


def test_mistake_loss_band():
    best = EngineEvaluation(engine="stockfish", score_cp=300)
    played = EngineEvaluation(engine="stockfish", score_cp=150)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.MISTAKE
    assert 0.10 < result.win_chance_loss <= 0.15


def test_large_loss_is_blunder():
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g2g4",
        best_move_uci="e2e4",
        played_eval_after=EngineEvaluation(engine="stockfish", score_cp=-500),
        best_eval_after=EngineEvaluation(engine="stockfish", score_cp=80),
    )
    assert result.classification is MoveClassification.BLUNDER
    assert result.win_chance_loss > 0.15


def test_excellent_boundary_is_two_percent_win_chance_loss():
    """The Excellent/Good boundary sits at a win-chance loss of 0.02 (2%). The browser's
    Brilliant candidate gate (web-src/coach/features.js BRILLIANT_MAX_CANDIDATE_WIN_DELTA
    = 2 points on the same scale) mirrors exactly this cutoff, so a move just inside must
    classify EXCELLENT and a move just outside must not."""
    def _loss(played_cp, best_cp=0):
        result = classify_move(
            side_to_move=Color.WHITE,
            played_move_uci="g1f3",
            best_move_uci="e2e4",
            played_eval_after=EngineEvaluation(engine="stockfish", score_cp=played_cp),
            best_eval_after=EngineEvaluation(engine="stockfish", score_cp=best_cp),
        )
        return result

    inside = _loss(-20)  # 0 -> -20 cp loss ≈ 1.84 win% points = 0.0184 probability
    assert inside.classification is MoveClassification.EXCELLENT
    assert inside.win_chance_loss <= 0.02

    outside = _loss(-25)  # ≈ 2.30 win% points = 0.0230 probability
    assert outside.classification is MoveClassification.GOOD
    assert outside.win_chance_loss > 0.02


def test_excellent_is_three_percent_not_excluded():
    """Guard against regression to the historical 0.03 (= 3%) cutoff the browser once
    mirrored: a ~2.5% loss must be GOOD, not EXCELLENT, or the browser candidate cap
    (2%) and this classifier disagree about which moves earn a Maia assessment."""
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=EngineEvaluation(engine="stockfish", score_cp=-22),
        best_eval_after=EngineEvaluation(engine="stockfish", score_cp=0),
    )
    # 0 -> -22 cp ≈ 2.02 win% points — just past the 2% Excellent boundary.
    assert result.win_chance_loss > 0.02
    assert result.win_chance_loss < 0.03
    assert result.classification is MoveClassification.GOOD


def test_loss_uses_mover_perspective_for_black():
    # White-perspective cp values; from Black's perspective the played move
    # is much worse than the best.
    best = EngineEvaluation(engine="stockfish", score_cp=-300)
    played = EngineEvaluation(engine="stockfish", score_cp=300)
    result = classify_move(
        side_to_move=Color.BLACK,
        played_move_uci="a7a6",
        best_move_uci="d8h4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.BLUNDER
    assert result.win_chance_loss > 0.15
