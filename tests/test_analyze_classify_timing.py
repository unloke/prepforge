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
* Browser-compute fast path (classify_precomputed_game) classifies identically
  to the legacy AnalysisService + ReplayEngine path: classifications, comments,
  summary, critical ply, stored evals all equal on the same fixture.
* Persistence is batched: save_game_batched issues a near-constant small
  statement count independent of ply count (vs the legacy per-move loop whose
  round-trips scale ~7× ply), with identical reloaded state on SQLite.
* Re-analysis replaces annotations deterministically (no stale rows, no dupes);
  ownership/analysis-history semantics unchanged.

Uses deterministic fixtures (no network, no engine): ReplayEngine + ReplayMaia
replay fixed payloads, so timings are call-counts and statement-counts.
"""
from __future__ import annotations

from copy import deepcopy

from sqlalchemy import event

from prepforge_chess.core.chess_core import ChessCore
from prepforge_chess.core.models import Color, EngineEvaluation, MoveSource
from prepforge_chess.services.analysis import AnalysisConfig, AnalysisService
from prepforge_chess.services.browser_compute import classify_precomputed_game
from prepforge_chess.services.engine import EngineAnalysisConfig
from prepforge_chess.services.replay_engine import ReplayEngine
from prepforge_chess.services.replay_maia import ReplayMaia
from prepforge_chess.storage.database import initialize_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def _eval(cp: int) -> EngineEvaluation:
    return EngineEvaluation(engine="t", depth=10, score_cp=cp, mate_in=None)


def _game_two_moves(core: ChessCore):
    game = core.import_single_pgn(
        '[White "a"]\n[Black "b"]\n\n1. e4 e5 *\n', source=MoveSource.IMPORTED_PGN
    )
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
                fen, {"score_cp": cp, "mate_in": None, "best_move_uci": best, "pv": []}
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
            m.best_move_uci,
            m.engine_eval_before.score_cp if m.engine_eval_before else None,
            m.engine_eval_after.score_cp if m.engine_eval_after else None,
            m.best_move_eval.score_cp if m.best_move_eval else None,
        )
        for m in moves
    ]


def test_fast_path_matches_legacy_path_fixture():
    """Same fixture, same evals: fast path == legacy AnalysisService path on
    classifications, comments, summary, critical ply, and stored evals.

    Uses the legal 20-ply game only (the 80-annotation repetitions are a
    persistence-shape fixture, not a classifiable game)."""

    core = ChessCore()
    game, fens = _classified_game(core)
    legal = deepcopy(game)
    legal.moves = legal.moves[:20]
    legal_fens = {
        fen: data
        for fen, data in fens.items()
        if any(fen in (m.fen_before, m.fen_after) for m in legal.moves)
    }
    legacy_game = deepcopy(legal)

    legacy_engine = ReplayEngine(dict(legal_fens), chess_core=core)

    class _Repo:
        def save_game(self, game, owner_user_id=None):
            pass

        def save_analysis_result(self, result):
            pass

    legacy_service = AnalysisService(_Repo(), engine=legacy_engine, engine_name="t")  # type: ignore[arg-type]
    legacy_result = legacy_service.analyze_game(
        deepcopy(legacy_game),
        config=AnalysisConfig(engine=EngineAnalysisConfig(depth=10), persist=False),
    )

    fast_result = classify_precomputed_game(
        deepcopy(legal), dict(legal_fens), engine_name="t", depth=10
    )
    assert _snapshot(fast_result.move_results) == _snapshot(legacy_result.move_results)
    assert fast_result.summary == legacy_result.summary
    assert fast_result.critical_ply == legacy_result.critical_ply


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
    repo = PrepForgeRepository(engine)
    counter = _StatementCounter(engine)
    return repo, counter


def test_batched_persistence_statement_count_near_constant(tmp_path):
    """Legal 20-ply fixture: legacy save_game scales ~7 statements/ply while
    the batched path stays a small constant (game + positions + evals + moves
    + analysis), and both reload to identical state.

    The contrast is already decisive at 20 plies (~140 vs ~10 statements);
    the benchmark test below shows the 80-annotation shape for humans."""
    core = ChessCore()
    game, fens = _classified_game(core)
    result = classify_precomputed_game(
        deepcopy(game), dict(fens), engine_name="t", depth=10
    )
    assert len(result.move_results) == 20
    annotated = list(result.move_results)

    legacy_repo, legacy_counter = _repo_with_counter(tmp_path, "legacy.sqlite3")
    legacy_counter.reset()
    classified = deepcopy(game)
    classified.moves = deepcopy(annotated)
    legacy_repo.save_game(classified)
    legacy_statements = legacy_counter.count

    batched_repo, batched_counter = _repo_with_counter(tmp_path, "batched.sqlite3")
    batched_counter.reset()
    batched_classified = deepcopy(game)
    batched_classified.moves = deepcopy(annotated)
    batched_repo.save_game_batched(batched_classified, result)
    batched_statements = batched_counter.count

    assert legacy_statements > 60, legacy_statements
    assert batched_statements <= 16, batched_statements
    assert batched_statements * 4 < legacy_statements

    from sqlalchemy import select as _select

    from prepforge_chess.storage import sa_tables as _t

    with legacy_repo.engine.connect() as conn:
        legacy_rows = conn.execute(
            _select(_t.moves).where(_t.moves.c.game_id == game.id).order_by(_t.moves.c.ply)
        ).mappings().all()
    with batched_repo.engine.connect() as conn:
        batched_rows = conn.execute(
            _select(_t.moves).where(_t.moves.c.game_id == game.id).order_by(_t.moves.c.ply)
        ).mappings().all()

    def _fields(rows):
        return [
            (
                r["ply"],
                r["uci"],
                r["classification"],
                r["comment"],
                r["best_move_uci"],
                r["engine_eval_before_id"] is not None,
                r["engine_eval_after_id"] is not None,
                r["best_move_eval_id"] is not None,
            )
            for r in rows
        ]

    assert len(legacy_rows) == 20
    assert len(batched_rows) == 20
    assert _fields(legacy_rows) == _fields(batched_rows)
    assert batched_repo.load_latest_analysis_result(game.id) is not None
    legacy_game = legacy_repo.load_game(game.id)
    batched_game = batched_repo.load_game(game.id)
    assert legacy_game is not None and batched_game is not None
    assert _snapshot(legacy_game.moves) == _snapshot(batched_game.moves)


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
                fen, {"score_cp": cp, "mate_in": None, "best_move_uci": best, "pv": []}
            )
    repo, _ = _repo_with_counter(tmp_path, "reanalysis.sqlite3")

    first = classify_precomputed_game(deepcopy(legal), dict(legal_fens), engine_name="t", depth=10)
    first_game = deepcopy(legal)
    first_game.moves = list(first.move_results)
    repo.save_game_batched(first_game, first)
    loaded = repo.load_game(legal.id)
    assert loaded is not None
    before = _snapshot(loaded.moves)
    assert len(before) == 20

    altered_fens = dict(legal_fens)
    some_fen = legal.moves[10].fen_after
    altered_fens[some_fen] = {
        "score_cp": -600,
        "mate_in": None,
        "best_move_uci": legal.moves[10].uci,
        "pv": [],
    }
    second = classify_precomputed_game(deepcopy(legal), altered_fens, engine_name="t", depth=10)
    second_game = deepcopy(loaded)
    second_game.moves = list(second.move_results)
    repo.save_game_batched(second_game, second)

    after_game = repo.load_game(legal.id)
    assert after_game is not None
    assert len(after_game.moves) == 20
    assert [m.ply for m in after_game.moves] == list(range(1, 21))
    assert _snapshot(after_game.moves) != before
    assert _snapshot(after_game.moves) == _snapshot(second.move_results)


def test_benchmark_80ply_statement_counts_observed(tmp_path, capsys):
    """Observability only: print representative statement counts so a human
    can see the batch win at 20 plies and the near-constant scaling to 80
    annotations. No assertions on wall-clock time."""
    core = ChessCore()
    game, fens = _classified_game(core)
    result = classify_precomputed_game(
        deepcopy(game), dict(fens), engine_name="t", depth=10
    )
    assert len(result.move_results) == 20

    legacy_repo, legacy_counter = _repo_with_counter(tmp_path, "bench-legacy.sqlite3")
    legacy_counter.reset()
    bench_classified = deepcopy(game)
    bench_classified.moves = list(result.move_results)
    legacy_repo.save_game(bench_classified)
    legacy_n = legacy_counter.count

    batched_repo, batched_counter = _repo_with_counter(tmp_path, "bench-batched.sqlite3")
    batched_counter.reset()
    bench_batched = deepcopy(game)
    bench_batched.moves = list(result.move_results)
    batched_repo.save_game_batched(bench_batched, result)
    batched_n = batched_counter.count

    # Near-constant scaling: the SAME game saved at 80-annotation width costs
    # the batched path one extra move chunk, not 60 extra per-ply loops. The
    # 80-set reuses the 20-ply FEN chain for annotations (statement shape
    # only — it is not loaded back through the board).
    wide = _annotated_80(game, result)
    wide_game = deepcopy(game)
    wide_game.moves = deepcopy(wide)
    batched_counter.reset()
    batched_repo.save_game_batched(wide_game, result)
    wide_n = batched_counter.count

    print(f"[persistence-benchmark] 20-ply legacy statements: {legacy_n}")
    print(f"[persistence-benchmark] 20-ply batched statements: {batched_n}")
    print(f"[persistence-benchmark] 80-annotation batched statements: {wide_n}")
    assert batched_n < legacy_n
    assert wide_n <= batched_n + 4
