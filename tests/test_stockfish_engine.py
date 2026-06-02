import pytest

from prepforge_chess.core.chess_core import STARTING_FEN
from prepforge_chess.services.engine import EngineAnalysisConfig, StockfishEngine
from prepforge_chess.services.stockfish_download import find_stockfish_executable


def test_stockfish_engine_analyzes_start_position_when_available():
    executable = find_stockfish_executable()
    if executable is None:
        pytest.skip("Stockfish executable is not installed.")

    engine = StockfishEngine(executable)
    try:
        analysis = engine.analyze_position(
            STARTING_FEN,
            EngineAnalysisConfig(depth=4, multipv=1),
        )
    finally:
        engine.close()

    assert analysis.evaluation.engine == "stockfish"
    assert analysis.candidates
    assert len(analysis.candidates[0].move_uci) >= 4
