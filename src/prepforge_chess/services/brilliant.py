from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Optional

import chess

from prepforge_chess.core.models import Color, EngineEvaluation, MoveClassification
from prepforge_chess.services.classification import win_chance_for_side
from prepforge_chess.services.engine import EngineAdapter, EngineAnalysisConfig
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
    3. **Trap** — the move a human would *naturally* play instead throws the
       advantage away. ``trap_gap = sf_truth(played) − sf_truth(Maia's
       top-policy move) ≥ min_trap_gap``. This is what makes a brilliancy a
       brilliancy: not just hard to find, but the *obvious* alternative is a
       real mistake, so finding this move actually mattered.

    The third layer used to be a "sound" check (``sf_truth`` stays winning and
    doesn't drop vs the pre-move eval). That was a stand-in chosen before a
    better discriminator existed: on a 23-move human-labeled set (8 genuine
    brilliancies, 15 false positives that *all* cleared layers 1–2) the sound
    check kept 10 of the 15 false positives, while ``trap_gap ≥ 0.05`` kept
    none of them and dropped no real brilliancy. See
    ``scripts/brilliant_probe5_newgate.py`` for that replay and
    ``scripts/brilliant_probe2_corr.py`` for the per-feature AUC (sound's
    sub-conditions sat at AUC≈0.5 on the labeled set; trap_gap at ~0.97).

    Computing ``trap_gap`` needs Maia's policy (which move humans would play)
    plus one Stockfish eval of the position *after* that move. Either the
    analyzer does this itself (a Maia adapter + an engine — the local/script
    path), or it accepts a value the caller already computed: the public browser
    flow runs both models client-side and supplies ``trap_gap`` via
    ``ReplayMaia.precomputed_trap_gap``. When neither is available (no engine and
    no client value) the trap layer can't be evaluated and the move is not flagged.

    No Lc0: Maia3 is the human model (policy *and* value), Stockfish is the
    objective truth.
    """

    enabled: bool = True
    rating: int = 1900
    max_human_probability: float = 0.10
    min_reveal_score: float = 0.30
    min_trap_gap: float = 0.05


@dataclass(frozen=True)
class BrilliantResult:
    is_brilliant: bool
    human_probability: float
    maia_glance_wc: float
    sf_truth_wc: float
    sf_before_wc: float
    reveal_score: float
    trap_gap: Optional[float] = None


BRILLIANT_ELIGIBLE_CLASSIFICATIONS = frozenset(
    {MoveClassification.BEST, MoveClassification.EXCELLENT}
)


class BrilliantAnalyzer:
    """Decide whether a Best or Excellent move is also Brilliant.

    Only moves already classified Best or Excellent by the Stockfish classifier
    are eligible. The human model is Maia3 (``maia``): its move probability says
    how unintuitive the move is, its value of the resulting position is the
    human "first glance", and its top-policy move is the one a human would
    naturally play (used for ``trap_gap``). The objective truth is the
    Stockfish evaluation that the analysis pipeline already produced, passed in
    here; the optional ``engine`` is used only for the single extra eval the
    trap layer needs (the position after the human's natural move) — unless the
    Maia adapter already exposes a precomputed ``trap_gap`` (the browser flow),
    in which case that value is used and no engine is required.
    """

    def __init__(
        self,
        *,
        maia: Optional[MaiaAdapter] = None,
        engine: Optional[EngineAdapter] = None,
        engine_config: Optional[EngineAnalysisConfig] = None,
        config: BrilliantConfig = BrilliantConfig(),
    ):
        self.maia = maia
        self.engine = engine
        self.engine_config = engine_config or EngineAnalysisConfig(multipv=1)
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

        # Prefer a client-precomputed trap_gap: the public browser flow runs no server
        # engine, so it computes trap_gap locally and supplies it via ReplayMaia. Fall
        # back to computing it here when an engine is wired (the local/script path).
        trap_gap = self._precomputed_trap_gap(fen_before, played_move_uci)
        if trap_gap is None:
            trap_gap = self._trap_gap(
                fen_before=fen_before,
                played_move_uci=played_move_uci,
                side_to_move=side_to_move,
                sf_truth_wc=sf_truth_wc,
                effective=effective,
            )

        is_brilliant = (
            human_probability <= effective.max_human_probability
            and reveal_score >= effective.min_reveal_score
            and trap_gap is not None
            and trap_gap >= effective.min_trap_gap
        )

        return BrilliantResult(
            is_brilliant=is_brilliant,
            human_probability=human_probability,
            maia_glance_wc=maia_glance_wc,
            sf_truth_wc=sf_truth_wc,
            sf_before_wc=sf_before_wc,
            reveal_score=reveal_score,
            trap_gap=trap_gap,
        )

    def _precomputed_trap_gap(
        self, fen_before: str, played_move_uci: str
    ) -> Optional[float]:
        """A trap_gap the Maia adapter already knows (the browser-supplied value), or None.

        ReplayMaia exposes ``precomputed_trap_gap`` so the analyzer can use the client's
        number directly — the public server has no engine to compute it. A real
        MaiaAdapter has no such method, so this returns None there and the engine path
        runs instead. Any lookup failure also degrades to None (trap layer un-evaluable →
        move not flagged), never aborting analysis.
        """
        lookup = getattr(self.maia, "precomputed_trap_gap", None)
        if not callable(lookup):
            return None
        try:
            value = lookup(fen_before, played_move_uci)
        except Exception:
            return None
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _trap_gap(
        self,
        *,
        fen_before: str,
        played_move_uci: str,
        side_to_move: Color,
        sf_truth_wc: float,
        effective: BrilliantConfig,
    ) -> Optional[float]:
        """sf_truth(played) − sf_truth(the move Maia thinks a human would play).

        Needs Maia's policy (top move) and one engine eval of the position that
        natural move leads to. Returns None when either is unavailable, so the
        caller can treat the trap layer as un-evaluable rather than passed.
        """
        if self.engine is None:
            return None
        try:
            with self._lock:
                predictions = self.maia.predictions(
                    fen_before, rating=effective.rating
                )
        except Exception:
            return None
        if not predictions:
            return None

        human_uci = predictions[0].move_uci
        if human_uci == played_move_uci:
            # The move a human would naturally play *is* this move — no trap.
            return 0.0

        try:
            board = chess.Board(fen_before)
            board.push(chess.Move.from_uci(human_uci))
            with self._lock:
                human_eval = self.engine.evaluate_position(
                    board.fen(), self.engine_config
                )
        except Exception:
            return None
        return sf_truth_wc - win_chance_for_side(human_eval, side_to_move)
