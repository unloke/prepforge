from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List, Optional

import chess
import chess.pgn

from prepforge_chess.core.models import (
    Color,
    Game,
    GameResult,
    MoveRecord,
    MoveSource,
    Position,
)


STARTING_FEN = chess.STARTING_FEN


@dataclass(frozen=True)
class PositionStatus:
    is_check: bool
    is_checkmate: bool
    is_stalemate: bool
    is_insufficient_material: bool
    legal_move_count: int


def color_from_python_chess(turn: bool) -> Color:
    return Color.WHITE if turn == chess.WHITE else Color.BLACK


def game_result_from_header(value: str) -> GameResult:
    for result in GameResult:
        if result.value == value:
            return result
    return GameResult.UNKNOWN


class ChessCore:
    """Shared chess rules, PGN, FEN, UCI, and SAN adapter.

    UI and services should call this wrapper instead of using `python-chess`
    directly. That keeps the rest of the app stable if the underlying rules
    implementation changes later.
    """

    def board(self, fen: str = STARTING_FEN) -> chess.Board:
        return chess.Board(fen)

    def normalize_fen(self, fen: str) -> str:
        return self.board(fen).fen()

    def side_to_move(self, fen: str) -> Color:
        return color_from_python_chess(self.board(fen).turn)

    def legal_moves(self, fen: str) -> List[str]:
        return [move.uci() for move in self.board(fen).legal_moves]

    def position_from_fen(self, fen: str) -> Position:
        board = self.board(fen)
        return Position(
            fen=board.fen(),
            side_to_move=color_from_python_chess(board.turn),
            move_number=board.fullmove_number,
            halfmove_clock=board.halfmove_clock,
            fullmove_number=board.fullmove_number,
            legal_moves=[move.uci() for move in board.legal_moves],
        )

    def status(self, fen: str) -> PositionStatus:
        board = self.board(fen)
        return PositionStatus(
            is_check=board.is_check(),
            is_checkmate=board.is_checkmate(),
            is_stalemate=board.is_stalemate(),
            is_insufficient_material=board.is_insufficient_material(),
            legal_move_count=board.legal_moves.count(),
        )

    def is_legal_uci(self, fen: str, move_uci: str) -> bool:
        board = self.board(fen)
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError:
            return False
        return move in board.legal_moves

    def san_to_uci(self, fen: str, san: str) -> str:
        board = self.board(fen)
        move = board.parse_san(san)
        return move.uci()

    def uci_to_san(self, fen: str, move_uci: str) -> str:
        board = self.board(fen)
        move = self._parse_legal_uci(board, move_uci)
        return board.san(move)

    def apply_uci(
        self,
        fen: str,
        move_uci: str,
        *,
        source: MoveSource = MoveSource.MANUAL,
        ply: Optional[int] = None,
        comment: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> MoveRecord:
        board = self.board(fen)
        move = self._parse_legal_uci(board, move_uci)
        return self._record_and_push(
            board=board,
            move=move,
            source=source,
            ply=ply,
            comment=comment,
            tags=tags,
        )

    def apply_san(
        self,
        fen: str,
        san: str,
        *,
        source: MoveSource = MoveSource.MANUAL,
        ply: Optional[int] = None,
    ) -> MoveRecord:
        board = self.board(fen)
        move = board.parse_san(san)
        return self._record_and_push(board=board, move=move, source=source, ply=ply)

    def apply_uci_sequence(
        self,
        fen: str,
        moves_uci: Iterable[str],
        *,
        source: MoveSource = MoveSource.MANUAL,
    ) -> List[MoveRecord]:
        board = self.board(fen)
        records: List[MoveRecord] = []
        for index, move_uci in enumerate(moves_uci, start=1):
            move = self._parse_legal_uci(board, move_uci)
            records.append(
                self._record_and_push(
                    board=board,
                    move=move,
                    source=source,
                    ply=index,
                )
            )
        return records

    def import_pgn_games(
        self,
        pgn_text: str,
        *,
        source: MoveSource = MoveSource.IMPORTED_PGN,
    ) -> List[Game]:
        stream = io.StringIO(pgn_text)
        games: List[Game] = []
        index = 0

        while True:
            parsed = chess.pgn.read_game(stream)
            if parsed is None:
                break
            if parsed.errors:
                first = parsed.errors[0]
                message = getattr(first, "args", [None])[0] or str(first)
                raise ValueError(
                    "PGN game {0} has parse errors: {1}".format(index + 1, message)
                )
            games.append(self._game_from_python_chess(parsed, source=source))
            index += 1

        return games

    def import_single_pgn(
        self,
        pgn_text: str,
        *,
        source: MoveSource = MoveSource.IMPORTED_PGN,
    ) -> Game:
        games = self.import_pgn_games(pgn_text, source=source)
        if len(games) != 1:
            raise ValueError(f"expected exactly one PGN game, found {len(games)}")
        return games[0]

    def _game_from_python_chess(self, parsed: chess.pgn.Game, *, source: MoveSource) -> Game:
        board = parsed.board()
        initial_fen = board.fen()
        moves: List[MoveRecord] = []

        for ply, move in enumerate(parsed.mainline_moves(), start=1):
            moves.append(
                self._record_and_push(
                    board=board,
                    move=move,
                    source=source,
                    ply=ply,
                )
            )

        headers: Dict[str, str] = dict(parsed.headers)
        played_at = self._parse_pgn_date(headers.get("UTCDate") or headers.get("Date"))

        return Game(
            id=str(uuid.uuid4()),
            source=source,
            initial_fen=initial_fen,
            moves=moves,
            white=headers.get("White"),
            black=headers.get("Black"),
            result=game_result_from_header(headers.get("Result", "*")),
            event=headers.get("Event"),
            site=headers.get("Site"),
            played_at=played_at,
            pgn=str(parsed),
            lichess_id=self._lichess_id_from_site(headers.get("Site")),
            tags=headers,
        )

    def _record_and_push(
        self,
        *,
        board: chess.Board,
        move: chess.Move,
        source: MoveSource,
        ply: Optional[int],
        comment: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> MoveRecord:
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {move.uci()} for FEN {board.fen()}")

        fen_before = board.fen()
        san = board.san(move)
        side = color_from_python_chess(board.turn)
        move_number = board.fullmove_number
        record_ply = ply if ply is not None else self._ply_from_board(board)
        board.push(move)

        return MoveRecord(
            uci=move.uci(),
            san=san,
            fen_before=fen_before,
            fen_after=board.fen(),
            move_number=move_number,
            ply=record_ply,
            side_to_move=side,
            source=source,
            comment=comment,
            tags=tags or [],
        )

    def _parse_legal_uci(self, board: chess.Board, move_uci: str) -> chess.Move:
        try:
            move = chess.Move.from_uci(move_uci)
        except ValueError as exc:
            raise ValueError(f"invalid UCI move: {move_uci}") from exc
        if move not in board.legal_moves:
            raise ValueError(f"illegal move {move_uci} for FEN {board.fen()}")
        return move

    def _ply_from_board(self, board: chess.Board) -> int:
        return (board.fullmove_number - 1) * 2 + (1 if board.turn == chess.WHITE else 2)

    def _parse_pgn_date(self, value: Optional[str]) -> Optional[datetime]:
        if not value or "?" in value:
            return None
        for fmt in ("%Y.%m.%d", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                continue
        return None

    def _lichess_id_from_site(self, site: Optional[str]) -> Optional[str]:
        if not site or "lichess.org/" not in site:
            return None
        return site.rstrip("/").split("/")[-1]
