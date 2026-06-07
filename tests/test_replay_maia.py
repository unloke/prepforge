from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.services.replay_maia import ReplayMaia

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def test_replay_maia_returns_seeded_assessment():
    maia = ReplayMaia(
        [{"fen": START_FEN, "uci": "e2e4", "human_probability": 0.03, "win_chance_after": 0.41}]
    )
    assert maia.move_assessment(START_FEN, "e2e4") == (0.03, 0.41)


def test_replay_maia_none_for_unseeded_move():
    maia = ReplayMaia(
        [{"fen": START_FEN, "uci": "e2e4", "human_probability": 0.03, "win_chance_after": 0.41}]
    )
    # A move with no client-supplied assessment → None (analyzer skips Brilliant).
    assert maia.move_assessment(START_FEN, "d2d4") is None
    assert maia.move_assessment("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1", "e2e4") is None


def test_replay_maia_normalizes_fen_and_uci_case():
    # Lookups are robust to FEN whitespace and UCI case (mirrors ReplayEngine keying).
    maia = ReplayMaia(
        [{"fen": START_FEN + "  ", "uci": "E2E4", "human_probability": 0.1, "win_chance_after": 0.2}],
        chess_core=ChessCore(),
    )
    assert maia.move_assessment(START_FEN, "e2e4") == (0.1, 0.2)


def test_replay_maia_skips_malformed_items_without_raising():
    # ReplayMaia itself is lenient (the server validates the payload before building it);
    # a non-string fen/uci item is just ignored, not crashed on.
    maia = ReplayMaia(
        [
            {"fen": 123, "uci": "e2e4", "human_probability": 0.1, "win_chance_after": 0.2},
            {"fen": START_FEN, "uci": "e2e4", "human_probability": 0.05, "win_chance_after": 0.1},
        ]
    )
    assert maia.move_assessment(START_FEN, "e2e4") == (0.05, 0.1)
