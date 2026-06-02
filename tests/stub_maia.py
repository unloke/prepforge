"""Deterministic Maia stand-in for tests.

This is intentionally *not* in the production package: production code must use
the real Maia3 model and fail loudly when it is unavailable, rather than silently
degrading to a fake (which previously masked real load failures). Tests that
exercise tree generation / repertoire plumbing — and only need *stable* move
probabilities, not chess strength — inject this stub explicitly.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import chess

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.services.maia import MaiaMovePrediction


class StubMaia:
    """Stable, deterministic human-likelihood stub (no neural model)."""

    name = "stub-maia"

    def __init__(self, chess_core: Optional[ChessCore] = None):
        self.chess_core = chess_core or ChessCore()

    def move_assessment(
        self,
        fen: str,
        move_uci: str,
        *,
        rating: Optional[int] = None,
    ) -> Optional[Tuple[float, float]]:
        # No real human model, so Brilliant detection stays disabled under the stub.
        return None

    def predictions(
        self,
        fen: str,
        *,
        rating: Optional[int] = None,
    ) -> List[MaiaMovePrediction]:
        del rating
        board = self.chess_core.board(fen)
        legal_moves = list(board.legal_moves)
        legal_moves.sort(key=lambda move: self._move_score(board, move), reverse=True)

        weights = [35.0, 25.0, 15.0, 10.0, 7.0, 4.0, 2.0, 1.0]
        predictions: List[MaiaMovePrediction] = []
        for index, move in enumerate(legal_moves):
            weight = weights[index] if index < len(weights) else 0.5
            predictions.append(
                MaiaMovePrediction(
                    fen=fen,
                    move_uci=move.uci(),
                    probability=weight / 100.0,
                    model=self.name,
                    rank=index + 1,
                )
            )
        return predictions

    def _move_score(self, board: chess.Board, move: chess.Move) -> int:
        score = 0
        piece = board.piece_at(move.from_square)
        if piece is None:
            return score

        to_file = chess.square_file(move.to_square)
        to_rank = chess.square_rank(move.to_square)
        center_distance = abs(to_file - 3.5) + abs(to_rank - 3.5)
        score += int(20 - center_distance * 2)

        if board.is_capture(move):
            score += 12
        if piece.piece_type in {chess.KNIGHT, chess.BISHOP}:
            score += 8
        if piece.piece_type == chess.PAWN and abs(to_rank - chess.square_rank(move.from_square)) == 2:
            score += 6
        if move.promotion:
            score += 20

        return score
