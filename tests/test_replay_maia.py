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


def test_replay_maia_replays_client_trap_gap():
    # The browser computes trap_gap locally and ships it; ReplayMaia exposes it so the
    # analyzer can use it without a server engine. 0.0 is a real value (no trap), so it
    # must round-trip as 0.0, not be treated as "absent".
    maia = ReplayMaia(
        [
            {"fen": START_FEN, "uci": "e2e4", "human_probability": 0.03,
             "win_chance_after": 0.41, "trap_gap": 0.18},
            {"fen": START_FEN, "uci": "d2d4", "human_probability": 0.04,
             "win_chance_after": 0.40, "trap_gap": 0.0},
        ]
    )
    assert maia.precomputed_trap_gap(START_FEN, "e2e4") == 0.18
    assert maia.precomputed_trap_gap(START_FEN, "d2d4") == 0.0


def test_replay_maia_trap_gap_none_when_absent_or_unseeded():
    # An assessment with no trap_gap (the browser deemed the move ineligible) and a move
    # the browser never assessed both return None → the analyzer's trap layer can't judge.
    maia = ReplayMaia(
        [{"fen": START_FEN, "uci": "e2e4", "human_probability": 0.03, "win_chance_after": 0.41}]
    )
    assert maia.precomputed_trap_gap(START_FEN, "e2e4") is None
    assert maia.precomputed_trap_gap(START_FEN, "d2d4") is None
