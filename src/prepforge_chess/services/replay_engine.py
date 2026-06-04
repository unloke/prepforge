"""Replay engine — feeds pre-computed evaluations into the analysis pipeline.

Phase 2 of the browser-engine migration moves per-ply Stockfish compute into the
browser. The server no longer runs an engine for the public analyze flow; instead
the browser sends one evaluation per position and the server only classifies and
persists.

To avoid duplicating the classification / report / persistence logic, this adapter
implements the same :class:`~prepforge_chess.services.engine.EngineAdapter`
interface as a real engine, but every "analysis" is a dictionary lookup of the
browser-supplied score. The existing :class:`AnalysisService` then runs unchanged
with zero real compute.

A position the browser failed to send raises loudly rather than substituting a
fake eval — a missing eval would silently corrupt the classification.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import EngineEvaluation
from prepforge_chess.services.engine import (
    EngineAnalysisConfig,
    EngineCandidate,
    PositionAnalysis,
)


class ReplayEngineError(ValueError):
    """Raised when an evaluation is requested for a position the client never
    analysed. Surfaces as a client error (incomplete browser payload), not a
    silent misclassification."""


class ReplayEngine:
    """Inert engine that returns browser-computed evaluations by FEN.

    ``positions`` maps a FEN to ``{score_cp, mate_in, best_move_uci, pv}`` as
    produced by the browser Stockfish provider (scores already White-POV). The
    pipeline calls ``analyze_position(fen_before)`` (needs eval + best move +
    eval-after-best) and ``evaluate_position(fen_after)`` (needs that position's
    eval). Because a position's eval under best play equals the eval after the
    best move (negamax), the single root score seeds both.
    """

    def __init__(
        self,
        positions: Dict[str, Dict[str, object]],
        *,
        name: str = "stockfish (browser)",
        chess_core: Optional[ChessCore] = None,
    ) -> None:
        self.name = name
        self.chess_core = chess_core or ChessCore()
        # Re-key by normalized FEN so lookups are robust to incidental
        # whitespace / field differences between client and stored FENs.
        self._by_fen: Dict[str, Dict[str, object]] = {}
        for fen, data in positions.items():
            self._by_fen[self._key(fen)] = data

    def _key(self, fen: str) -> str:
        try:
            return self.chess_core.normalize_fen(fen)
        except Exception:
            return fen.strip()

    def _lookup(self, fen: str) -> Dict[str, object]:
        data = self._by_fen.get(self._key(fen))
        if data is None:
            raise ReplayEngineError(
                "no client evaluation for position: {0}".format(fen)
            )
        return data

    def _evaluation_for(
        self, fen: str, config: EngineAnalysisConfig
    ) -> EngineEvaluation:
        data = self._lookup(fen)
        score_cp = data.get("score_cp")
        mate_in = data.get("mate_in")
        return EngineEvaluation(
            engine=self.name,
            depth=config.depth,
            score_cp=int(score_cp) if score_cp is not None else None,
            mate_in=int(mate_in) if mate_in is not None else None,
            best_move_uci=data.get("best_move_uci") or None,
            pv=list(data.get("pv") or []),
        )

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        data = self._lookup(fen)
        evaluation = self._evaluation_for(fen, config)
        best_move_uci = data.get("best_move_uci") or None
        candidates: List[EngineCandidate] = []
        if best_move_uci:
            # The position's eval under best play == the eval after the best
            # move, so the rank-1 candidate's eval-after mirrors the root eval.
            candidates.append(
                EngineCandidate(
                    move_uci=str(best_move_uci),
                    evaluation_after=evaluation,
                    rank=1,
                    pv=list(data.get("pv") or []),
                )
            )
        return PositionAnalysis(fen=fen, evaluation=evaluation, candidates=candidates)

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        return self._evaluation_for(fen, config)
