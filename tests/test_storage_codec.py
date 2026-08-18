"""Round-trip and identity tests for the shipped storage codec."""
from __future__ import annotations

import chess

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    Color,
    EngineEvaluation,
    MoveClassification,
    MoveSource,
    OpeningNode,
)
from prepforge_chess.storage import codec


def test_long_game_round_trip():
    board = chess.Board()
    ucis = []
    rng = 99
    for _ in range(180):
        legal = list(board.legal_moves)
        if not legal:
            break
        rng = (rng * 1103515245 + 12345) & 0x7FFFFFFF
        move = legal[rng % len(legal)]
        ucis.append(move.uci())
        board.push(move)
    rebuilt = codec.rebuild_moves(STARTING_FEN, ucis)
    assert [m.uci for m in rebuilt] == ucis
    assert rebuilt[-1].fen_after == board.fen()
    assert len(rebuilt) >= 50


def test_uci_sequence_round_trip():
    blob = codec.encode_uci_sequence(["e2e4", "e7e5", "g1f3", "b8c6"])
    assert codec.decode_uci_sequence(blob) == ["e2e4", "e7e5", "g1f3", "b8c6"]
    assert codec.decode_uci_sequence("") == []
    assert codec.decode_uci_sequence(None) == []


def test_rebuild_moves_matches_chess_core_semantics():
    core = ChessCore()
    ucis = ["e2e4", "c7c5", "g1f3", "d7d6"]
    expected = core.apply_uci_sequence(STARTING_FEN, ucis, source=MoveSource.IMPORTED_PGN)
    rebuilt = codec.rebuild_moves(STARTING_FEN, ucis)
    assert [m.uci for m in rebuilt] == [m.uci for m in expected]
    assert [m.san for m in rebuilt] == [m.san for m in expected]
    assert [m.fen_before for m in rebuilt] == [m.fen_before for m in expected]
    assert [m.fen_after for m in rebuilt] == [m.fen_after for m in expected]
    assert [m.side_to_move for m in rebuilt] == [m.side_to_move for m in expected]
    assert [m.move_number for m in rebuilt] == [m.move_number for m in expected]


def test_rebuild_overlays_annotations():
    rebuilt = codec.rebuild_moves(
        STARTING_FEN,
        ["e2e4"],
        {
            1: {
                "classification": MoveClassification.BEST,
                "comment": "best",
                "tags": ["book"],
                "source": MoveSource.STOCKFISH,
            }
        },
    )
    assert rebuilt[0].classification is MoveClassification.BEST
    assert rebuilt[0].comment == "best"
    assert rebuilt[0].tags == ["book"]
    assert rebuilt[0].source is MoveSource.STOCKFISH
    assert rebuilt[0].fen_before == STARTING_FEN


def test_castling_promotion_ep_round_trip():
    # Castling
    castle_fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
    castle = codec.replay_uci(castle_fen, "e1g1")
    assert castle.san == "O-O"
    board = chess.Board(castle.fen_after)
    assert not board.has_kingside_castling_rights(chess.WHITE)
    assert board.has_kingside_castling_rights(chess.BLACK)

    # Promotion and underpromotion
    promo_fen = "8/P7/8/8/8/8/8/4k2K w - - 0 1"
    queen = codec.replay_uci(promo_fen, "a7a8q")
    knight = codec.replay_uci(promo_fen, "a7a8n")
    assert queen.san.endswith("=Q")
    assert knight.san.endswith("=N")
    assert chess.Board(queen.fen_after).piece_at(chess.A8).symbol() == "Q"
    assert chess.Board(knight.fen_after).piece_at(chess.A8).symbol() == "N"

    # En passant
    ep_before = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
    ep = codec.replay_uci(ep_before, "e5d6")
    assert chess.Board(ep.fen_after).piece_at(chess.D5) is None
    assert chess.Board(ep.fen_after).piece_at(chess.D6).symbol() == "P"


def test_position_identity_distinguishes_castling_ep_and_side():
    placement = "r3k2r/8/8/8/8/8/8/R3K2R"
    both = f"{placement} w KQkq - 0 1"
    no_white_castle = f"{placement} w kq - 0 1"
    black_to_move = f"{placement} b KQkq - 0 1"
    with_ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
    no_ep = "rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3"

    assert codec.position_key(both) != codec.position_key(no_white_castle)
    assert codec.position_key(both) != codec.position_key(black_to_move)
    assert codec.position_key(with_ep) != codec.position_key(no_ep)
    assert codec.position_identity(both)[2] == "KQkq"
    assert codec.position_identity(no_white_castle)[2] == "kq"
    assert codec.position_identity(both)[1] == "w"
    assert codec.position_identity(black_to_move)[1] == "b"
    assert codec.position_identity(with_ep)[3] == "d6"
    assert codec.position_identity(no_ep)[3] == "-"


def test_search_limit_sentinel_round_trip_is_null_safe():
    assert codec.encode_search_limit(None) == codec.UNSET_SEARCH_LIMIT
    assert codec.decode_search_limit(codec.encode_search_limit(None)) is None
    assert codec.decode_search_limit(codec.encode_search_limit(10)) == 10
    assert codec.encode_search_limit(0) == 0
    assert codec.decode_search_limit(0) == 0
    # Same unset config encodes identically so UNIQUE can match.
    assert codec.encode_search_limit(None) == codec.encode_search_limit(None)


def test_analysis_identity_includes_engine_config_not_score():
    fen = STARTING_FEN
    a = codec.analysis_identity(fen, "stockfish", 16, 50000, 80)
    b = codec.analysis_identity(fen, "stockfish", 20, 50000, 80)
    c = codec.analysis_identity(fen, "maia3", 16, 50000, 80)
    assert a != b
    assert a != c
    digest_a = codec.analysis_identity_digest(fen, "stockfish", 16, 50000, 80)
    digest_b = codec.analysis_identity_digest(fen, "stockfish", 16, 50000, 80)
    assert digest_a == digest_b
    assert len(digest_a) == 64  # full sha256, not a truncated hash


def test_wdl_and_pv_round_trip():
    encoded = codec.encode_wdl({"win": 0.35, "draw": 0.40, "loss": 0.25})
    decoded = codec.decode_wdl(*encoded)
    assert decoded == {"win": 0.35, "draw": 0.4, "loss": 0.25}
    assert codec.decode_wdl(None, None, None) is None
    assert codec.decode_pv(codec.encode_pv(["e2e4", "e7e5"])) == ["e2e4", "e7e5"]


def test_opening_tree_hydrate_from_uci_path():
    d4 = codec.replay_uci(STARTING_FEN, "d2d4")
    root = OpeningNode(
        id="root",
        repertoire_id="r",
        fen="",
        side_to_move=Color.WHITE,
    )
    child = OpeningNode(
        id="d4",
        repertoire_id="r",
        parent_id="root",
        fen="",
        side_to_move=Color.WHITE,
        source=MoveSource.MANUAL,
        engine_evaluation=EngineEvaluation(engine="stockfish", depth=12, score_cp=30),
    )
    nodes = {root.id: root, child.id: child}
    rebuilt = codec.hydrate_opening_tree(STARTING_FEN, nodes, {"root": None, "d4": "d2d4"})
    assert rebuilt is root
    assert root.fen == STARTING_FEN
    assert len(root.children) == 1
    assert root.children[0].move.uci == "d2d4"
    assert root.children[0].fen == d4.fen_after
    assert root.children[0].side_to_move is Color.BLACK
    assert root.children[0].move.engine_eval_after.score_cp == 30


def test_transposition_keeps_clocks_in_identity():
    # 1.e4 e5 2.Nf3 Nc6 vs 1.Nf3 Nc6 2.e4 e5: same placement/castling/EP/side,
    # but halfmove clocks differ (pawn endings vs two quiet knight moves). Those
    # are distinct 50-move states and must not collapse.
    a = codec.rebuild_moves(STARTING_FEN, ["e2e4", "e7e5", "g1f3", "b8c6"])
    b = codec.rebuild_moves(STARTING_FEN, ["g1f3", "b8c6", "e2e4", "e7e5"])
    ia, ib = codec.position_identity(a[-1].fen_after), codec.position_identity(b[-1].fen_after)
    assert ia[:4] == ib[:4]
    assert ia[4] != ib[4]
    assert codec.position_key(a[-1].fen_after) != codec.position_key(b[-1].fen_after)
    # Same path replayed twice is identical, including clocks.
    again = codec.rebuild_moves(STARTING_FEN, ["e2e4", "e7e5", "g1f3", "b8c6"])
    assert codec.position_key(a[-1].fen_after) == codec.position_key(again[-1].fen_after)
