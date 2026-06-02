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
    assert 0.0 < result.win_chance_loss <= 0.03


def test_moderate_loss_is_good():
    best = EngineEvaluation(engine="stockfish", score_cp=100)
    played = EngineEvaluation(engine="stockfish", score_cp=30)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.GOOD
    assert 0.03 < result.win_chance_loss <= 0.07


def test_inaccuracy_loss_band():
    best = EngineEvaluation(engine="stockfish", score_cp=200)
    played = EngineEvaluation(engine="stockfish", score_cp=20)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.INACCURACY
    assert 0.07 < result.win_chance_loss <= 0.23


def test_mistake_loss_band():
    best = EngineEvaluation(engine="stockfish", score_cp=300)
    played = EngineEvaluation(engine="stockfish", score_cp=-30)
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g1f3",
        best_move_uci="e2e4",
        played_eval_after=played,
        best_eval_after=best,
    )
    assert result.classification is MoveClassification.MISTAKE
    assert 0.23 < result.win_chance_loss <= 0.36


def test_large_loss_is_blunder():
    result = classify_move(
        side_to_move=Color.WHITE,
        played_move_uci="g2g4",
        best_move_uci="e2e4",
        played_eval_after=EngineEvaluation(engine="stockfish", score_cp=-500),
        best_eval_after=EngineEvaluation(engine="stockfish", score_cp=80),
    )
    assert result.classification is MoveClassification.BLUNDER
    assert result.win_chance_loss > 0.36


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
    assert result.win_chance_loss > 0.36
