from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Protocol

import chess
import chess.engine

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import EngineEvaluation


@dataclass(frozen=True)
class EngineAnalysisConfig:
    depth: Optional[int] = 10
    nodes: Optional[int] = None
    time_ms: Optional[int] = None
    multipv: int = 1


@dataclass(frozen=True)
class EngineCandidate:
    move_uci: str
    evaluation_after: EngineEvaluation
    rank: int
    pv: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class PositionAnalysis:
    fen: str
    evaluation: EngineEvaluation
    candidates: List[EngineCandidate] = field(default_factory=list)

    @property
    def best_move_uci(self) -> Optional[str]:
        return self.candidates[0].move_uci if self.candidates else None

    @property
    def best_evaluation_after(self) -> Optional[EngineEvaluation]:
        return self.candidates[0].evaluation_after if self.candidates else None


class EngineAdapter(Protocol):
    name: str

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        raise NotImplementedError

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        raise NotImplementedError


class MockEngine:
    """Deterministic local engine for pipeline development and tests.

    It is not chess strength. It gives stable material-based evaluations and a
    legal best move so the analysis pipeline can be exercised before a real UCI
    engine binary is configured.
    """

    name = "mockfish"

    def __init__(self, chess_core: Optional[ChessCore] = None):
        self.chess_core = chess_core or ChessCore()

    def analyze_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> PositionAnalysis:
        board = self.chess_core.board(fen)
        evaluation = self.evaluate_position(fen, config)

        candidates: List[EngineCandidate] = []
        for move in board.legal_moves:
            after_board = board.copy(stack=False)
            after_board.push(move)
            evaluation_after = self._evaluation_for_board(
                after_board,
                config=config,
                best_move_uci=move.uci(),
                pv=[move.uci()],
            )
            candidates.append(
                EngineCandidate(
                    move_uci=move.uci(),
                    evaluation_after=evaluation_after,
                    rank=0,
                    pv=[move.uci()],
                )
            )

        reverse = board.turn == chess.WHITE
        candidates.sort(key=lambda item: item.evaluation_after.score_cp or 0, reverse=reverse)
        ranked = [
            EngineCandidate(
                move_uci=candidate.move_uci,
                evaluation_after=candidate.evaluation_after,
                rank=index,
                pv=candidate.pv,
            )
            for index, candidate in enumerate(candidates[: max(1, config.multipv)], start=1)
        ]

        return PositionAnalysis(fen=fen, evaluation=evaluation, candidates=ranked)

    def evaluate_position(
        self,
        fen: str,
        config: EngineAnalysisConfig = EngineAnalysisConfig(),
    ) -> EngineEvaluation:
        return self._evaluation_for_board(self.chess_core.board(fen), config=config)

    def _evaluation_for_board(
        self,
        board,
        *,
        config: EngineAnalysisConfig,
        best_move_uci: Optional[str] = None,
        pv: Optional[List[str]] = None,
    ) -> EngineEvaluation:
        score_cp = self._score_board_cp(board)
        return EngineEvaluation(
            engine=self.name,
            depth=config.depth,
            nodes=config.nodes,
            time_ms=config.time_ms,
            score_cp=score_cp,
            best_move_uci=best_move_uci,
            pv=pv or [],
        )

    def _score_board_cp(self, board) -> int:
        if board.is_checkmate():
            return -100000 if board.turn == chess.WHITE else 100000
        if board.is_stalemate() or board.is_insufficient_material():
            return 0

        piece_values = {
            1: 100,
            2: 320,
            3: 330,
            4: 500,
            5: 900,
            6: 0,
        }
        score = 0
        for piece in board.piece_map().values():
            value = piece_values[piece.piece_type]
            score += value if piece.color == chess.WHITE else -value

        mobility = board.legal_moves.count()
        score += mobility if board.turn == chess.WHITE else -mobility
        return score
