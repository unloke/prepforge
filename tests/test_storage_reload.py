"""Save in one engine/process, load in another — not same-connection-only."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from prepforge_chess.core.chess_core import STARTING_FEN, ChessCore
from prepforge_chess.core.models import (
    AnalysisResult,
    EngineEvaluation,
    MoveClassification,
    utc_now,
)
from prepforge_chess.storage.database import connect_database, initialize_database
from prepforge_chess.storage.repositories import PrepForgeRepository

_LOADER = r"""
import json, sys
from prepforge_chess.storage.database import connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository
db, game_id = sys.argv[1], sys.argv[2]
engine = connect_database(db)
repo = PrepForgeRepository(engine)
game = repo.load_game(game_id)
analysis = repo.load_latest_analysis_result(game_id)
assert game is not None
assert analysis is not None
print(json.dumps({
    "uci": [m.uci for m in game.moves],
    "san": [m.san for m in game.moves],
    "fen_before0": game.moves[0].fen_before,
    "fen_after_last": game.moves[-1].fen_after,
    "classification0": game.moves[0].classification.value,
    "score": game.moves[0].engine_eval_after.score_cp,
    "summary": analysis.summary,
    "critical": analysis.critical_ply,
    "pgn_has_e4": "e4" in (game.pgn or ""),
}))
engine.dispose()
"""


def _build_game():
    core = ChessCore()
    game = core.import_single_pgn(
        """
[Event "Reload"]
[White "W"]
[Black "B"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    game.moves[0].classification = MoveClassification.BEST
    game.moves[0].engine_eval_after = EngineEvaluation(
        engine="stockfish",
        depth=12,
        nodes=100,
        time_ms=10,
        score_cp=28,
        best_move_uci="e2e4",
        pv=["e2e4", "e7e5"],
        wdl={"win": 0.4, "draw": 0.4, "loss": 0.2},
    )
    return game


def test_reload_from_fresh_engine(tmp_path):
    db = tmp_path / "reload.sqlite"
    engine = initialize_database(db)
    repo = PrepForgeRepository(engine)
    game = _build_game()
    repo.save_game(game)
    repo.save_analysis_result(
        AnalysisResult(
            game_id=game.id,
            analyzed_at=utc_now(),
            engine="stockfish",
            depth=12,
            move_results=game.moves,
            summary={"best": 1},
            critical_ply=[3],
        )
    )
    engine.dispose()

    engine2 = connect_database(db)
    repo2 = PrepForgeRepository(engine2)
    loaded = repo2.load_game(game.id)
    analysis = repo2.load_latest_analysis_result(game.id)
    assert loaded is not None
    assert [m.uci for m in loaded.moves] == [m.uci for m in game.moves]
    assert loaded.moves[0].fen_before == STARTING_FEN
    assert loaded.moves[0].classification is MoveClassification.BEST
    assert loaded.moves[0].engine_eval_after.score_cp == 28
    assert analysis is not None
    assert analysis.summary == {"best": 1}
    assert analysis.critical_ply == [3]
    engine2.dispose()


def test_reload_from_new_process_twice(tmp_path):
    db = tmp_path / "reload-proc.sqlite"
    engine = initialize_database(db)
    repo = PrepForgeRepository(engine)
    game = _build_game()
    repo.save_game(game)
    repo.save_analysis_result(
        AnalysisResult(
            game_id=game.id,
            analyzed_at=utc_now(),
            engine="stockfish",
            depth=12,
            move_results=game.moves,
            summary={"best": 1},
            critical_ply=[3],
        )
    )
    engine.dispose()

    results = []
    repo_root = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    env["PYTHONPATH"] = str(repo_root / "src") + (
        (";" + env["PYTHONPATH"]) if env.get("PYTHONPATH") else ""
    )
    for _ in range(2):
        proc = subprocess.run(
            [sys.executable, "-c", _LOADER, str(db), game.id],
            check=True,
            capture_output=True,
            text=True,
            cwd=str(repo_root),
            env=env,
        )
        results.append(json.loads(proc.stdout))
    assert results[0] == results[1]
    assert results[0]["uci"][0] == "e2e4"
    assert results[0]["fen_before0"] == STARTING_FEN
    assert results[0]["score"] == 28
    assert results[0]["critical"] == [3]
    assert results[0]["pgn_has_e4"] is True
