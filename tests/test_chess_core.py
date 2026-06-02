import pytest

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import Color, GameResult, MoveSource


def test_apply_uci_records_san_fen_and_side():
    core = ChessCore()

    record = core.apply_uci(STARTING_FEN, "e2e4", source=MoveSource.IMPORTED_PGN)

    assert record.uci == "e2e4"
    assert record.san == "e4"
    assert record.fen_before == STARTING_FEN
    assert record.side_to_move is Color.WHITE
    assert core.side_to_move(record.fen_after) is Color.BLACK


def test_castling_is_legal_and_recorded():
    core = ChessCore()
    fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"

    record = core.apply_uci(fen, "e1g1")

    assert record.san == "O-O"
    assert "R4RK1" in record.fen_after


def test_en_passant_is_supported():
    core = ChessCore()
    fen = "8/8/8/3pP3/8/8/8/4K2k w - d6 0 2"

    record = core.apply_uci(fen, "e5d6")

    assert record.san == "exd6"
    assert record.fen_after.startswith("8/8/3P4/8/8/8/8/4K2k")


def test_promotion_is_supported():
    core = ChessCore()
    fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"

    record = core.apply_uci(fen, "a7a8q")

    assert record.san.startswith("a8=Q")
    assert record.fen_after.startswith("Q3k3/8/8/8/8/8/8/4K3")


def test_illegal_move_raises_value_error():
    core = ChessCore()

    with pytest.raises(ValueError):
        core.apply_uci(STARTING_FEN, "e2e5")


def test_import_single_pgn_normalizes_moves():
    core = ChessCore()
    pgn = """
[Event "Unit Test"]
[Site "https://lichess.org/abcdef12"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""

    game = core.import_single_pgn(pgn)

    assert game.white == "Alice"
    assert game.black == "Bob"
    assert game.result is GameResult.WHITE_WIN
    assert game.lichess_id == "abcdef12"
    assert [move.uci for move in game.moves] == [
        "e2e4",
        "e7e5",
        "g1f3",
        "b8c6",
        "f1b5",
        "a7a6",
    ]
    assert game.moves[0].fen_before == STARTING_FEN
    assert game.moves[-1].source is MoveSource.IMPORTED_PGN


def test_board_state_legal_targets_contract():
    from prepforge_chess.ui.board_contract import BoardMode, BoardState

    core = ChessCore()
    state = BoardState(
        fen=STARTING_FEN,
        mode=BoardMode.ANALYZE,
        legal_moves=core.legal_moves(STARTING_FEN),
        selected_square="e2",
    )

    assert sorted(state.legal_targets_from("e2")) == ["e3", "e4"]
