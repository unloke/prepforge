from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from prepforge_chess.core.chess_core import ChessCore, PositionStatus
from prepforge_chess.core.models import Color, Game, MoveClassification, MoveRecord
from prepforge_chess.storage.repositories import PrepForgeRepository
from prepforge_chess.ui.board_contract import BoardMode, BoardState, HighlightKind, SquareHighlight


@dataclass(frozen=True)
class MoveListItem:
    ply: int
    move_number: int
    side_to_move: Color
    uci: str
    san: str
    classification: MoveClassification


@dataclass(frozen=True)
class GameNavigationState:
    game_id: str
    current_ply: int
    total_plies: int
    board_state: BoardState
    status: PositionStatus
    previous_move: Optional[MoveRecord]
    current_move: Optional[MoveRecord]
    next_move: Optional[MoveRecord]
    move_list: List[MoveListItem]


class GameNavigationService:
    """Build UI-ready board state for a stored game and selected ply."""

    def __init__(
        self,
        repository: PrepForgeRepository,
        chess_core: Optional[ChessCore] = None,
    ):
        self.repository = repository
        self.chess_core = chess_core or ChessCore()

    def state_for_game_id(
        self,
        game_id: str,
        ply: int = 0,
        mode: BoardMode = BoardMode.ANALYZE,
    ) -> GameNavigationState:
        game = self.repository.load_game(game_id)
        if game is None:
            raise ValueError("game not found: {0}".format(game_id))
        return self.state_for_game(game, ply=ply, mode=mode)

    def state_for_game(
        self,
        game: Game,
        ply: int = 0,
        mode: BoardMode = BoardMode.ANALYZE,
    ) -> GameNavigationState:
        if ply < 0 or ply > len(game.moves):
            raise ValueError("ply must be between 0 and {0}; got {1}".format(len(game.moves), ply))

        fen = game.initial_fen if ply == 0 else game.moves[ply - 1].fen_after
        status = self.chess_core.status(fen)
        last_move = game.moves[ply - 1] if ply > 0 else None

        board_state = BoardState(
            fen=fen,
            mode=mode,
            legal_moves=self.chess_core.legal_moves(fen),
            last_move_uci=last_move.uci if last_move is not None else None,
            highlighted_squares=self._last_move_highlights(last_move),
            metadata={
                "game_id": game.id,
                "current_ply": str(ply),
                "total_plies": str(len(game.moves)),
                "is_check": str(status.is_check).lower(),
                "is_checkmate": str(status.is_checkmate).lower(),
                "is_stalemate": str(status.is_stalemate).lower(),
            },
        )

        current_move = last_move
        previous_move = game.moves[ply - 2] if ply >= 2 else None
        next_move = game.moves[ply] if ply < len(game.moves) else None

        return GameNavigationState(
            game_id=game.id,
            current_ply=ply,
            total_plies=len(game.moves),
            board_state=board_state,
            status=status,
            previous_move=previous_move,
            current_move=current_move,
            next_move=next_move,
            move_list=[
                MoveListItem(
                    ply=move.ply,
                    move_number=move.move_number,
                    side_to_move=move.side_to_move,
                    uci=move.uci,
                    san=move.san,
                    classification=move.classification,
                )
                for move in game.moves
            ],
        )

    def next_state(self, game_id: str, current_ply: int) -> GameNavigationState:
        game = self.repository.load_game(game_id)
        if game is None:
            raise ValueError("game not found: {0}".format(game_id))
        return self.state_for_game(game, ply=min(len(game.moves), current_ply + 1))

    def previous_state(self, game_id: str, current_ply: int) -> GameNavigationState:
        game = self.repository.load_game(game_id)
        if game is None:
            raise ValueError("game not found: {0}".format(game_id))
        return self.state_for_game(game, ply=max(0, current_ply - 1))

    def _last_move_highlights(self, move: Optional[MoveRecord]) -> List[SquareHighlight]:
        if move is None:
            return []
        return [
            SquareHighlight(move.uci[:2], HighlightKind.LAST_MOVE),
            SquareHighlight(move.uci[2:4], HighlightKind.LAST_MOVE),
        ]
