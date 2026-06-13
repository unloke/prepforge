from prepforge_chess.core.models import MoveClassification
from prepforge_chess.services.analysis import (
    AnalysisCancelled,
    AnalysisConfig,
    AnalysisService,
    CancellationToken,
)
from prepforge_chess.services.brilliant import BrilliantResult
from prepforge_chess.services.engine import EngineAnalysisConfig, MockEngine
from prepforge_chess.services.pgn_import import PgnImportService
from prepforge_chess.storage.database import apply_schema, connect_database
from prepforge_chess.storage.repositories import PrepForgeRepository


def _repository_with_game():
    connection = connect_database()
    apply_schema(connection)
    repository = PrepForgeRepository(connection)
    result = PgnImportService(repository).import_text(
        """
[Event "Analysis"]
[Site "https://lichess.org/analysis1"]
[Date "2026.05.25"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
    )
    return repository, result.imported_game_ids[0]


def test_analysis_service_classifies_and_persists_moves():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())

    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(engine=EngineAnalysisConfig(depth=8, multipv=1)),
    )

    assert result.engine == "mockfish"
    assert result.depth == 8
    assert len(result.move_results) == 6
    assert sum(result.summary.values()) == 6
    assert all(move.classification is not MoveClassification.UNKNOWN for move in result.move_results)
    assert all(move.engine_eval_before is not None for move in result.move_results)
    assert all(move.engine_eval_after is not None for move in result.move_results)
    assert all(move.best_move_uci for move in result.move_results)

    loaded = repository.load_game(game_id)
    assert loaded is not None
    assert loaded.moves[0].engine_eval_after is not None
    assert loaded.moves[0].classification is not MoveClassification.UNKNOWN

    latest = repository.load_latest_analysis_result(game_id)
    assert latest is not None
    assert latest.engine == "mockfish"
    assert latest.summary == result.summary


def test_analysis_can_run_without_persistence():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())

    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert len(result.move_results) == 6
    assert repository.load_latest_analysis_result(game_id) is None


def test_analysis_emits_progress_events():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())
    events = []

    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(persist=False),
        progress_callback=events.append,
    )

    assert result.move_results
    assert events[0].phase == "started"
    assert events[-1].phase == "completed"
    assert events[-1].percent_complete == 1.0
    assert [event.phase for event in events].count("move_complete") == 6
    assert events[1].phase == "analyzing"
    assert events[1].current_ply == 1


def test_analysis_can_be_cancelled_from_progress_callback():
    repository, game_id = _repository_with_game()
    service = AnalysisService(repository, engine=MockEngine())
    token = CancellationToken()

    def cancel_after_second_move(progress):
        if progress.phase == "move_complete" and progress.current_ply == 2:
            token.cancel()

    try:
        service.analyze_game_id(
            game_id,
            config=AnalysisConfig(persist=True),
            progress_callback=cancel_after_second_move,
            cancel_token=token,
        )
    except AnalysisCancelled:
        pass
    else:
        raise AssertionError("expected AnalysisCancelled")

    assert repository.load_latest_analysis_result(game_id) is None


def test_parallel_analysis_preserves_move_order_and_classifies_all_moves():
    repository, game_id = _repository_with_game()
    created_engines = []

    def engine_factory():
        engine = MockEngine()
        created_engines.append(engine)
        return engine

    service = AnalysisService(
        repository,
        engine_factory=engine_factory,
        engine_name="mockfish",
    )
    result = service.analyze_game_id(
        game_id,
        config=AnalysisConfig(persist=False, max_workers=2),
    )

    assert len(created_engines) <= 2
    assert [move.ply for move in result.move_results] == [1, 2, 3, 4, 5, 6]
    assert all(move.classification is not MoveClassification.UNKNOWN for move in result.move_results)


class _CountingEngine:
    """Wraps a real engine and records every distinct position searched, so a test can
    prove the per-run cache stops the analyzer from recomputing overlapping FENs
    (fen_after(N) == fen_before(N+1)) and repeated positions."""

    def __init__(self, inner=None):
        self._inner = inner or MockEngine()
        self.name = self._inner.name
        self.analyze_calls = []
        self.evaluate_calls = []

    def analyze_position(self, fen, config=None):
        self.analyze_calls.append(fen)
        return self._inner.analyze_position(fen, config) if config else self._inner.analyze_position(fen)

    def evaluate_position(self, fen, config=None):
        self.evaluate_calls.append(fen)
        return self._inner.evaluate_position(fen, config) if config else self._inner.evaluate_position(fen)


def test_per_run_cache_searches_each_distinct_position_once():
    repository, game_id = _repository_with_game()
    engine = _CountingEngine()
    service = AnalysisService(repository, engine=engine, engine_name="mockfish")

    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    # 6 plies → 7 distinct board positions (start + one per ply). Without the cache the
    # service would issue 6 analyze + 6 evaluate = 12 searches; the overlap means several
    # of those are the SAME FEN. With the cache every distinct position is searched once.
    all_searched = engine.analyze_calls + engine.evaluate_calls
    assert len(set(all_searched)) == 7
    assert len(all_searched) == 7  # no FEN searched twice
    assert engine.evaluate_calls == []  # multipv-1 path serves fen_after via analysis

    # Results are unaffected: every move still classified with evals present.
    assert len(result.move_results) == 6
    assert all(m.classification is not MoveClassification.UNKNOWN for m in result.move_results)
    assert all(m.engine_eval_after is not None for m in result.move_results)


def test_per_run_cache_keeps_results_identical_to_uncached():
    # Same game analyzed via the cache (default) must match a direct/no-cache analysis.
    repo_a, game_a = _repository_with_game()
    repo_b, game_b = _repository_with_game()

    cached = AnalysisService(repo_a, engine=MockEngine()).analyze_game_id(
        game_a, config=AnalysisConfig(persist=False)
    )

    # Force the uncached path by calling _analyze_move with eval_cache=None semantics via a
    # fresh service whose cache we bypass: compare the public per-move evals/classifications.
    service_b = AnalysisService(repo_b, engine=MockEngine())
    game_obj = repo_b.load_game(game_b)
    from copy import deepcopy as _dc

    uncached_moves = [
        service_b._analyze_move(_dc(m), None, service_b.engine, AnalysisConfig(), None)
        for m in game_obj.moves
    ]

    for cm, um in zip(cached.move_results, uncached_moves):
        assert cm.classification == um.classification
        assert cm.engine_eval_after.score_cp == um.engine_eval_after.score_cp
        assert cm.engine_eval_before.score_cp == um.engine_eval_before.score_cp
        assert cm.best_move_uci == um.best_move_uci


def test_analysis_requires_brilliant_flag_before_promoting_classification():
    repository, game_id = _repository_with_game()

    class NonBrilliantAnalyzer:
        def evaluate(self, **kwargs):
            return BrilliantResult(
                is_brilliant=False,
                human_probability=0.5,
                maia_glance_wc=0.5,
                sf_truth_wc=0.5,
                sf_before_wc=0.5,
                reveal_score=0.0,
            )

    service = AnalysisService(
        repository,
        engine=MockEngine(),
        brilliant_analyzer=NonBrilliantAnalyzer(),
    )
    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert MoveClassification.BRILLIANT not in {
        move.classification for move in result.move_results
    }


def test_analysis_promotes_to_brilliant_when_analyzer_says_so():
    repository, game_id = _repository_with_game()

    class AlwaysBrilliantAnalyzer:
        def __init__(self):
            self.seen = []

        def evaluate(self, *, classification, **kwargs):
            self.seen.append(classification)
            return BrilliantResult(
                is_brilliant=True,
                human_probability=0.01,
                maia_glance_wc=0.3,
                sf_truth_wc=0.7,
                sf_before_wc=0.5,
                reveal_score=0.4,
            )

    analyzer = AlwaysBrilliantAnalyzer()
    service = AnalysisService(
        repository,
        engine=MockEngine(),
        brilliant_analyzer=analyzer,
    )
    result = service.analyze_game_id(game_id, config=AnalysisConfig(persist=False))

    assert all(
        c in {MoveClassification.BEST, MoveClassification.EXCELLENT}
        for c in analyzer.seen
    )
    assert MoveClassification.BRILLIANT in {
        move.classification for move in result.move_results
    }
