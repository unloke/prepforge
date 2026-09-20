"""Phase-instrumented classify-save timing (Analyze pipeline).

Regression guard for the "classifying takes longer than stockfish+maia" report:
the browser toast used to label the whole tail (Maia inference + trap batch +
classify-save + render) as "classifying". The pipeline now records per-phase
timings (prepare, load, stockfish, maia-load, maia-inference, maia-traps detail,
classify-save, render) via deterministic instrumentation — no wall-clock
thresholds. These tests pin the SERVER side of that contract: classify-save is
pure replay (zero engine compute), single classification pass per move, and the
trap-gap path never recomputes evals.

Uses the repo's deterministic fixture game (no network, no engine): ReplayEngine
+ ReplayMaia replay fixed payloads, so timings are call-counts, not milliseconds.
"""
from __future__ import annotations

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource
from prepforge_chess.services.analysis import AnalysisConfig, AnalysisService
from prepforge_chess.services.engine import EngineAnalysisConfig
from prepforge_chess.services.replay_engine import ReplayEngine
from prepforge_chess.services.replay_maia import ReplayMaia


def _eval(cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="t", depth=10, score_cp=cp, mate_in=None)


def _game_two_moves(core: ChessCore):
    game = core.import_pgn_games(
        '[White "a"]\n[Black "b"]\n\n1. e4 e5 *\n', source=MoveSource.IMPORTED_PGN
    )[0]
    return game


def test_replay_engine_single_lookup_per_position_per_move():
    """classify-save must not re-run classification or double-process evals.

    The shared fen_after(N) == fen_before(N+1) positions are analyzed ONCE via
    the per-run eval cache (3 distinct FENs for 2 moves → 3 analyze calls, 0
    separate evaluates at multipv 1), with no repeats and no second pass."""
    core = ChessCore()
    game = _game_two_moves(core)
    fens = []
    for move in game.moves:
        fens.append(move.fen_before)
    fens.append(game.moves[-1].fen_after)

    calls: list[tuple[str, str]] = []

    positions = {
        fen: {"score_cp": 20, "mate_in": None, "best_move_uci": None, "pv": []} for fen in fens
    }

    engine = ReplayEngine(positions, chess_core=core)
    orig_analyze = engine.analyze_position
    orig_evaluate = engine.evaluate_position

    def counting_analyze(fen, config=None):
        calls.append(("analyze", fen))
        return orig_analyze(fen, config or EngineAnalysisConfig())

    def counting_evaluate(fen, config=None):
        calls.append(("evaluate", fen))
        return orig_evaluate(fen, config or EngineAnalysisConfig())

    engine.analyze_position = counting_analyze  # type: ignore[method-assign]
    engine.evaluate_position = counting_evaluate  # type: ignore[method-assign]

    from prepforge_chess.storage.repositories import PrepForgeRepository  # noqa: F401

    class _Repo:
        def save_game(self, game, owner_user_id=None):
            pass

        def save_analysis_result(self, result):
            pass

    service = AnalysisService(_Repo(), engine=engine, engine_name="t")  # type: ignore[arg-type]
    result = service.analyze_game(
        game, config=AnalysisConfig(engine=EngineAnalysisConfig(depth=10), persist=False)
    )
    assert len(result.move_results) == 2
    # 3 distinct FENs, each analyzed exactly once; shared fen_after(N) ==
    # fen_before(N+1) positions are cache hits (no separate evaluate at
    # multipv 1), and no FEN is ever searched twice.
    assert len(calls) == 3
    assert all(kind == "analyze" for kind, _ in calls)
    assert len({fen for _, fen in calls}) == 3


def test_classify_move_called_once_per_move(monkeypatch):
    """The classifier runs exactly once per move (no duplicate classification)."""
    import prepforge_chess.services.analysis as analysis_mod

    core = ChessCore()
    game = _game_two_moves(core)
    fens = [m.fen_before for m in game.moves] + [game.moves[-1].fen_after]
    positions = {
        fen: {"score_cp": 20, "mate_in": None, "best_move_uci": None, "pv": []} for fen in fens
    }
    engine = ReplayEngine(positions, chess_core=core)

    count = {"n": 0}
    orig = analysis_mod.classify_move

    def counting(**kwargs):
        count["n"] += 1
        return orig(**kwargs)

    monkeypatch.setattr(analysis_mod, "classify_move", counting)

    class _Repo:
        def save_game(self, game, owner_user_id=None):
            pass

        def save_analysis_result(self, result):
            pass

    service = AnalysisService(_Repo(), engine=engine, engine_name="t")  # type: ignore[arg-type]
    service.analyze_game(
        game, config=AnalysisConfig(engine=EngineAnalysisConfig(depth=10), persist=False)
    )
    assert count["n"] == len(game.moves) == 2


def test_replay_maia_never_runs_inference_for_classify():
    """ReplayMaia replays browser numbers; predictions() (move generation) is
    never consulted on the classify path — no second Maia processing."""
    maia = ReplayMaia(
        [{"fen": "f", "uci": "e2e4", "human_probability": 0.1, "win_chance_after": 0.5}]
    )
    assert maia.move_assessment("f", "e2e4") == (0.1, 0.5)
    assert maia.precomputed_trap_gap("f", "e2e4") is None
    try:
        maia.predictions()
    except NotImplementedError:
        pass
    else:  # pragma: no cover - contract guard
        raise AssertionError("ReplayMaia.predictions must stay unimplemented on classify path")


def test_trap_gap_replay_avoids_engine_recompute():
    """When the browser ships trap_gap, BrilliantAnalyzer uses it directly and
    never touches an engine — the trap layer adds zero server compute."""
    from prepforge_chess.core.models import MoveClassification
    from prepforge_chess.services.brilliant import BrilliantAnalyzer, BrilliantConfig

    maia = ReplayMaia(
        [
            {
                "fen": "f",
                "uci": "e2e4",
                "human_probability": 0.01,
                "win_chance_after": 0.9,
                "trap_gap": 0.2,
            }
        ]
    )

    class _NoEngine:
        def __getattr__(self, name):
            raise AssertionError(f"engine must not be consulted (got {name})")

    analyzer = BrilliantAnalyzer(maia=maia, engine=_NoEngine())
    result = analyzer.evaluate(
        classification=MoveClassification.BEST,
        fen_before="f",
        played_move_uci="e2e4",
        side_to_move=Color.WHITE,
        stockfish_eval_before=_eval(300),
        stockfish_eval_after=_eval(300),
        config=BrilliantConfig(enabled=True),
    )
    assert result is not None
    assert result.trap_gap == 0.2
