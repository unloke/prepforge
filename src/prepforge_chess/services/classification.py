from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification


WC_SIGMOID_SCALE = 0.00368208
CP_CLAMP = 1000


@dataclass(frozen=True)
class ClassificationConfig:
    """Win-chance loss thresholds (mover's perspective)."""

    excellent_loss: float = 0.03
    good_loss: float = 0.07
    inaccuracy_loss: float = 0.23
    mistake_loss: float = 0.36


@dataclass(frozen=True)
class ClassificationResult:
    classification: MoveClassification
    win_chance_loss: float
    reason: str


def cp_to_win_chance(cp: Optional[int]) -> float:
    """Lichess-style normalized win chance from a centipawn score.

    The cp value is interpreted from the mover's perspective and clipped to
    [-CP_CLAMP, CP_CLAMP] before applying the sigmoid.
    """

    if cp is None:
        return 0.5
    clamped = max(-CP_CLAMP, min(CP_CLAMP, int(cp)))
    return 1.0 / (1.0 + math.exp(-WC_SIGMOID_SCALE * clamped))


def evaluation_to_white_win_chance(evaluation: EngineEvaluation) -> float:
    """Convert a White-perspective EngineEvaluation into a White win chance."""

    if evaluation.mate_in is not None:
        if evaluation.mate_in > 0:
            return cp_to_win_chance(CP_CLAMP)
        if evaluation.mate_in < 0:
            return cp_to_win_chance(-CP_CLAMP)
        return 0.5
    return cp_to_win_chance(evaluation.score_cp)


def win_chance_for_side(evaluation: EngineEvaluation, side: Color) -> float:
    white_wc = evaluation_to_white_win_chance(evaluation)
    return white_wc if side is Color.WHITE else 1.0 - white_wc


def classify_move(
    *,
    side_to_move: Color,
    played_move_uci: str,
    best_move_uci: Optional[str],
    played_eval_after: EngineEvaluation,
    best_eval_after: EngineEvaluation,
    config: ClassificationConfig = ClassificationConfig(),
) -> ClassificationResult:
    """Classify a move using win-chance loss from the mover's perspective.

    loss = best_wc_after - played_wc_after, both from the mover's perspective.
    best_wc_after comes from Stockfish's first choice; played_wc_after comes
    from the actual played move. Brilliant is decided separately by
    :class:`prepforge_chess.services.brilliant.BrilliantAnalyzer` after this
    classification has run.
    """

    if best_move_uci and played_move_uci == best_move_uci:
        return ClassificationResult(
            MoveClassification.BEST,
            0.0,
            "matched Stockfish first choice",
        )

    played_wc = win_chance_for_side(played_eval_after, side_to_move)
    best_wc = win_chance_for_side(best_eval_after, side_to_move)
    loss = max(0.0, best_wc - played_wc)

    if loss <= config.excellent_loss:
        return ClassificationResult(
            MoveClassification.EXCELLENT,
            loss,
            "small win-chance loss",
        )
    if loss <= config.good_loss:
        return ClassificationResult(
            MoveClassification.GOOD,
            loss,
            "acceptable win-chance loss",
        )
    if loss <= config.inaccuracy_loss:
        return ClassificationResult(
            MoveClassification.INACCURACY,
            loss,
            "noticeable but recoverable drop",
        )
    if loss <= config.mistake_loss:
        return ClassificationResult(
            MoveClassification.MISTAKE,
            loss,
            "large practical drop",
        )
    return ClassificationResult(
        MoveClassification.BLUNDER,
        loss,
        "decisive practical drop",
    )
