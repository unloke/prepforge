from __future__ import annotations

from typing import List

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Game, MoveSource


def import_pgn_games(pgn_text: str, *, source: MoveSource = MoveSource.IMPORTED_PGN) -> List[Game]:
    return ChessCore().import_pgn_games(pgn_text, source=source)


def import_single_pgn(pgn_text: str, *, source: MoveSource = MoveSource.IMPORTED_PGN) -> Game:
    return ChessCore().import_single_pgn(pgn_text, source=source)
