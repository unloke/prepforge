from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Optional

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.classification import win_chance_for_side
from prepforge_chess.services.maia import MaiaAdapter


@dataclass(frozen=True)
class BrilliantConfig:
    """Thresholds for Brilliant detection, powered by Maia3 + Stockfish.

    A Brilliant move clears three layers, all required:

    1. **Unintuitive** — a human is unlikely to find it: the Maia3 policy
       probability of the move is at most ``max_human_probability``.
    2. **Looks bad, but is good (reveal)** — a human's first-glance read of the
       resulting position is poor, yet the objective truth is high. The glance
       is Maia3's value of the position after the move; the truth is the
       Stockfish eval already computed during analysis. ``reveal = sf_truth −
       maia_glance ≥ min_reveal_score``.
    3. **Sound** — already Best/Excellent by Stockfish, and the Stockfish truth
       stays winning/equal (``≥ min_high_win_chance``, and not a drop of more
       than ``max_high_drop_vs_before`` from the pre-move eval).

    No Lc0: Maia3 is the human model (policy *and* value), Stockfish is the
    objective truth.
    """

    enabled: bool = True
    rating: int = 1900
    max_human_probability: float = 0.10
    min_reveal_score: float = 0.30
    max_high_drop_vs_before: float = 0.05
    min_high_win_chance: float = 0.50


@dataclass(frozen=True)
class BrilliantResult:
    is_brilliant: bool
    human_probability: float
    maia_glance_wc: float
    sf_truth_wc: float
    sf_before_wc: float
    reveal_score: float


BRILLIANT_ELIGIBLE_CLASSIFICATIONS = frozenset(
    {MoveClassification.BEST, MoveClassification.EXCELLENT}
)


class BrilliantAnalyzer:
    """Decide whether a Best or Excellent move is also Brilliant.

    Only moves already classified Best or Excellent by the Stockfish classifier
    are eligible. The human model is Maia3 (``maia``): its move probability says
    how unintuitive the move is, and its value of the resulting position is the
    human "first glance". The objective truth is the Stockfish evaluation that
    the analysis pipeline already produced, passed in here.
    """

    def __init__(
        self,
        *,
        maia: Optional[MaiaAdapter] = None,
        config: BrilliantConfig = BrilliantConfig(),
    ):
        self.maia = maia
        self.config = config
        self._lock = threading.Lock()

    def evaluate(
        self,
        *,
        classification: MoveClassification,
        fen_before: str,
        played_move_uci: str,
        side_to_move: Color,
        stockfish_eval_before: Optional[EngineEvaluation],
        stockfish_eval_after: Optional[EngineEvaluation],
        config: Optional[BrilliantConfig] = None,
    ) -> Optional[BrilliantResult]:
        """Return a BrilliantResult or None when ineligible / disabled.

        Returns None if Maia3 is not configured, brilliant detection is
        disabled, the classification is not Best/Excellent, the objective
        after-eval is missing, or Maia3 could not assess the move.
        """

        effective = config or self.config
        if not effective.enabled or self.maia is None:
            return None
        if classification not in BRILLIANT_ELIGIBLE_CLASSIFICATIONS:
            return None
        if stockfish_eval_after is None:
            return None

        try:
            with self._lock:
                assessment = self.maia.move_assessment(
                    fen_before, played_move_uci, rating=effective.rating
                )
        except Exception:
            # A failed Maia3 inference must not abort the whole game analysis.
            return None
        if assessment is None:
            return None
        human_probability, maia_glance_wc = assessment

        sf_truth_wc = win_chance_for_side(stockfish_eval_after, side_to_move)
        sf_before_wc = (
            win_chance_for_side(stockfish_eval_before, side_to_move)
            if stockfish_eval_before is not None
            else sf_truth_wc
        )
        reveal_score = sf_truth_wc - maia_glance_wc

        is_brilliant = (
            human_probability <= effective.max_human_probability
            and reveal_score >= effective.min_reveal_score
            and sf_truth_wc >= sf_before_wc - effective.max_high_drop_vs_before
            and sf_truth_wc >= effective.min_high_win_chance
        )

        return BrilliantResult(
            is_brilliant=is_brilliant,
            human_probability=human_probability,
            maia_glance_wc=maia_glance_wc,
            sf_truth_wc=sf_truth_wc,
            sf_before_wc=sf_before_wc,
            reveal_score=reveal_score,
        )
