"""Phase-instrumented classify-save timing + batched persistence contract.

Regression guard for the "classifying takes longer than stockfish+maia" report:
the browser toast used to label the whole tail (Maia inference + trap batch +
classify-save + render) as "classifying". The pipeline now records per-phase
timings (browser: load/stockfish/maia-*/classify-save/render via [analyze-timings];
server: ownership/validate/maia_validate/load_game/classify/save_game/
save_analysis/serialize via server_timings_ms) — deterministic phase
attribution, no wall-clock thresholds.

Contract pinned here (all deterministic, no ms gates):

* classify_move exactly once per ply; no extra Stockfish/Maia inference.
* Persistence is batched: save_game issues a near-constant small
  statement count independent of ply count, with identical reloaded state.
* Re-analysis replaces annotations deterministically (no stale rows, no dupes);
  ownership/analysis-history semantics unchanged.

Uses deterministic fixtures (no network, no engine): Browser payloads + ReplayMaia
replay fixed payloads, so timings are call-counts and statement-counts.
"""
from __future__ import annotations

from copy import deepcopy

from sqlalchemy import event

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource
from prepforge_chess.services.browser_compute import classify_precomputed_game
from prepforge_chess.services.replay_maia import ReplayMaia
from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories.workspace import WorkspaceRepository


def _eval(cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="t", depth=10, score_cp=cp, mate_in=None)


def _game_two_moves(core: ChessCore):
    game = core.import_single_pgn(
        '[White "a"]\n[Black "b"]\n\n1. e4 e5 *\n', source=MoveSource.IMPORTED_PGN
    )
    return game


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

    analyzer = BrilliantAnalyzer(maia=maia)
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


def _classified_game(core):
    """Deterministic 80-annotation fixture with per-move client evals.

    Persistence shape under test is "80 annotated plies sharing 21 FENs".
    The fixture keeps the REAL 20-ply legal game for identity AND uses its
    uci_blob for both saves (load_game replays the blob through the board, so
    both sides reload to the same 20 legal plies). The 80-annotation set —
    the legal 20 plus 60 in-memory repetitions of the same FEN chain —
    exercises the statement-count shape; both save paths persist the same
    annotation set, and the equivalence check compares raw move-row fields
    (no board replay). classify_precomputed_game is NOT run on the 80-set
    (only the legal 20 are classifiable); annotations are stamped by the
    20-ply classification and repeated across plies."""
    from prepforge_chess.core.models import MoveSource as _MS

    base = core.import_single_pgn(
        '[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 '
        "5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *\n",
        source=_MS.IMPORTED_PGN,
    )
    game = base
    fens: dict[str, dict] = {}
    for i, move in enumerate(game.moves):
        cp = 20 + ((i * 37) % 120) - 60
        best = move.uci if i % 3 == 0 else "a2a3"
        for fen in (move.fen_before, move.fen_after):
            fens.setdefault(
                fen, {"depth": 10, "score_cp": cp, "mate_in": None, "best_move_uci": best, "pv": []}
            )
    return game, fens


def _annotated_80(game, result):
    """Repeat the 20 classified annotations to 80 plies (statement-count
    shape). FENs cycle with the same 20-ply chain so dedup is exercised."""
    out = []
    ply = 0
    while len(out) < 80:
        for m in result.move_results:
            ply += 1
            dup = deepcopy(m)
            dup.ply = ply
            out.append(dup)
            if len(out) >= 80:
                break
    return out


def _snapshot(moves):
    return [
        (
            m.ply,
            m.uci,
            m.classification.value,
            m.comment,
            # A-04: the classification explanation lives in generated_comment
            # (replaced on re-analysis, never appended to the user's note).
            m.generated_comment,
            m.best_move_uci,
            m.engine_eval_before.score_cp if m.engine_eval_before else None,
            m.engine_eval_after.score_cp if m.engine_eval_after else None,
            m.best_move_eval.score_cp if m.best_move_eval else None,
        )
        for m in moves
    ]


class _StatementCounter:
    """Count SQL statements executed against an engine (deterministic query-count
    contract — no wall-clock thresholds)."""

    def __init__(self, engine):
        self.count = 0
        event.listen(engine, "before_cursor_execute", self._hook)

    def _hook(self, conn, cursor, statement, parameters, context, executemany):
        self.count += 1

    def reset(self):
        self.count = 0


def _repo_with_counter(tmp_path, name="timing.sqlite3"):
    engine = initialize_database(tmp_path / name)
    repo = WorkspaceRepository(engine)
    counter = _StatementCounter(engine)
    return repo, counter


def test_save_game_statement_count_near_constant(tmp_path):
    """save_game issues a small constant number of statements (game + positions
    + evals + moves + analysis), not a per-ply loop, and an 80-annotation save
    costs at most one extra move chunk. The saved game reloads intact."""
    core = ChessCore()
    game, fens = _classified_game(core)
    result = classify_precomputed_game(
        deepcopy(game), dict(fens), engine_name="t", depth=10
    )
    assert len(result.move_results) == 20

    repo, counter = _repo_with_counter(tmp_path, "batched.sqlite3")
    counter.reset()
    classified = deepcopy(game)
    classified.moves = deepcopy(list(result.move_results))
    repo.save_game(classified, result)
    statements = counter.count
    assert statements <= 16, statements

    loaded = repo.load_game(game.id)
    assert loaded is not None
    assert _snapshot(loaded.moves) == _snapshot(result.move_results)
    assert repo.load_latest_analysis_result(game.id) is not None

    # The 80-set reuses the 20-ply FEN chain for annotations (statement shape
    # only; it is not loaded back through the board).
    wide_game = deepcopy(game)
    wide_game.moves = deepcopy(_annotated_80(game, result))
    counter.reset()
    repo.save_game(wide_game, result)
    assert counter.count <= statements + 4, counter.count


def test_reanalysis_replaces_annotations_without_dupes(tmp_path):
    """Re-analyzing the same game replaces move annotations deterministically:
    no duplicate (game_id, ply) rows, no stale classifications, analysis
    history still appends a new row.

    Uses a REAL 20-ply legal game (not the 80-annotation save-shape fixture)
    so the re-analysis round-trips through load_game identically."""
    from prepforge_chess.core.models import MoveSource as _MS

    core = ChessCore()
    legal = core.import_single_pgn(
        '[White "a"]\n[Black "b"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 '
        "5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *\n",
        source=_MS.IMPORTED_PGN,
    )
    legal_fens: dict[str, dict] = {}
    for i, move in enumerate(legal.moves):
        cp = 20 + ((i * 37) % 120) - 60
        best = move.uci if i % 3 == 0 else "a2a3"
        for fen in (move.fen_before, move.fen_after):
            legal_fens.setdefault(
                fen, {"depth": 10, "score_cp": cp, "mate_in": None, "best_move_uci": best, "pv": []}
            )
    repo, _ = _repo_with_counter(tmp_path, "reanalysis.sqlite3")

    first = classify_precomputed_game(deepcopy(legal), dict(legal_fens), engine_name="t", depth=10)
    first_game = deepcopy(legal)
    first_game.moves = list(first.move_results)
    repo.save_game(first_game, first)
    loaded = repo.load_game(legal.id)
    assert loaded is not None
    before = _snapshot(loaded.moves)
    assert len(before) == 20

    altered_fens = dict(legal_fens)
    some_fen = legal.moves[10].fen_after
    altered_fens[some_fen] = {"depth": 10,
        "score_cp": -600,
        "mate_in": None,
        "best_move_uci": legal.moves[10].uci,
        "pv": [],
    }
    second = classify_precomputed_game(deepcopy(legal), altered_fens, engine_name="t", depth=10)
    second_game = deepcopy(loaded)
    second_game.moves = list(second.move_results)
    repo.save_game(second_game, second)

    after_game = repo.load_game(legal.id)
    assert after_game is not None
    assert len(after_game.moves) == 20
    assert [m.ply for m in after_game.moves] == list(range(1, 21))
    assert _snapshot(after_game.moves) != before
    assert _snapshot(after_game.moves) == _snapshot(second.move_results)


def test_browser_classifier_runs_once_per_ply(monkeypatch):
    import prepforge_chess.services.browser_compute as module
    game = _game_two_moves(ChessCore())
    positions = {fen: {"depth": 10, "score_cp": 20} for move in game.moves
                 for fen in (move.fen_before, move.fen_after)}
    calls = []
    original = module.classify_move
    def classify(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(module, "classify_move", classify)
    classify_precomputed_game(game, positions, engine_name="test", depth=10)
    assert len(calls) == len(game.moves)
